import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { runDiscovery } from '../src/discovery.js';
import { DispatchGuard, attachNetworkPolicy, guardedNavigateRelative } from '../src/runtime.js';
import { createEvidenceWriter } from '../src/evidence.js';
import type { OperatorDecision } from '../src/operator.js';
import type { Profile } from '../src/profile.js';


let browser: Browser;
let app: Server;
let forbidden: Server;
let fakeModel: Server;
let appOrigin = '';
let forbiddenOrigin = '';
let scratchEvidenceDir: string;
const appHits: string[] = [];
const forbiddenHits: string[] = [];
const modelRequests: string[] = [];
let script: object[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  scratchEvidenceDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  forbidden = createServer((req, res) => {
    forbiddenHits.push(`${req.method} ${req.url}`);
    res.end('reached');
  });
  app = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    appHits.push(`${req.method} ${path}`);
    if (path === '/redirect-out') {
      res.writeHead(302, { location: `${forbiddenOrigin}/leak-redirect` });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      path === '/'
        ? '<!doctype html><h1>Account</h1><form action="/mutate" method="get"><button>Confirm payment</button></form><a href="/redirect-out">Statements</a> <a href="/next">Details</a>'
        : '<!doctype html><h1>Next page</h1>',
    );
  });
  let messageCount = 0;
  fakeModel = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      modelRequests.push(body);
      const input = script.shift() ?? { kind: 'done', reason: 'script exhausted' };
      messageCount++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: `msg_${messageCount}`,
          type: 'message',
          role: 'assistant',
          model: 'fake-model',
          content: [{ type: 'tool_use', id: `toolu_${messageCount}`, name: 'act', input }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  forbiddenOrigin = await listen(forbidden);
  appOrigin = await listen(app);
  process.env.ANTHROPIC_BASE_URL = await listen(fakeModel);
  process.env.ANTHROPIC_API_KEY = 'test-key-not-a-real-key';
  process.env.ANTHROPIC_MODEL = 'fake-model';
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  for (const server of [app, forbidden, fakeModel]) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratchEvidenceDir, { recursive: true, force: true });
});

async function discover(actions: object[], operatorPrompt?: (page: import('playwright').Page) => Promise<OperatorDecision>) {
  const profile: Profile = {
    id: 'discovery-policy-test',
    entryPath: '/',
    allowedOrigin: appOrigin,
    allowedRoutePatterns: [/^\/$/, /^\/redirect-out$/, /^\/mutate$/, /^\/next$/],
  };
  script = [...actions];
  modelRequests.length = 0;
  appHits.length = 0;
  forbiddenHits.length = 0;
  const evidence = createEvidenceWriter('discover');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  try {
    await attachNetworkPolicy(guard, profile);
    await guardedNavigateRelative(guard, guard.session.controlEpoch, page, '/', profile);
    const result = await runDiscovery(page, 'Read the account page', {}, {}, profile, guard, evidence, {
      operatorPrompt: operatorPrompt ? () => operatorPrompt(page) : undefined,
    });
    const raw = readFileSync(evidence.filePath, 'utf8');
    return { result, raw, events: raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) };
  } finally {
    await page.context().close();
  }
}

test('discovery: a model-proposed risky click and a redirecting click are blocked, fed back as codes, and never enter the trace', async () => {
  const run = await discover([
    { kind: 'click', target: 'Confirm payment', reason: 'Safe read-only click with no side effects' },
    { kind: 'click', target: 'Statements', reason: 'open statements' },
    { kind: 'done', reason: 'finished' },
  ]);

  assert.equal(run.result.stuckReason, undefined);
  assert.equal(run.result.turns, 3);
  assert.deepEqual(run.result.trace, [], 'blocked actions must never be compiled into an artifact');
  assert.ok(!appHits.includes('GET /mutate'), 'the risky endpoint receives no request');
  assert.deepEqual(forbiddenHits, [], 'the redirect target receives no request');

  const blocks = run.events.filter((event) => event.event === 'policy_blocked');
  assert.ok(blocks.some((b) => b.code === 'RISKY_CONTROL' && b.phase === 'pre-dispatch' && b.matchedTerm === 'confirm'));
  assert.ok(blocks.some((b) => b.code === 'ORIGIN_NOT_ALLOWED' && b.phase === 'network' && b.redirect === true));

  assert.match(modelRequests[1] ?? '', /blocked by runtime policy \(RISKY_CONTROL\)/);
  assert.match(modelRequests[2] ?? '', /blocked by runtime policy \(ORIGIN_NOT_ALLOWED\)/);
  assert.doesNotMatch(run.raw, /Safe read-only|Confirm payment|leak-redirect/);
});

test('discovery: a stuck escalation records sanitized human activity in the same live page', async () => {
  const run = await discover(
    [
      { kind: 'stuck', reason: 'cannot find the control' },
      { kind: 'done', reason: 'finished' },
    ],
    async (page) => {
      await page.getByRole('link', { name: 'Details' }).click();
      await page.waitForLoadState('load');
      await new Promise((resolve) => setTimeout(resolve, 300));
      return 'resume';
    },
  );

  assert.equal(run.result.stuckReason, undefined);
  const humanActions = run.events.filter((event) => event.event === 'human_action');
  assert.ok(humanActions.some((a) => a.kind === 'click' && a.element === 'link'));
  assert.ok(humanActions.some((a) => a.kind === 'navigation' && a.route === '^\\/next$'));
  const handback = run.events.find((event) => event.event === 'handback');
  assert.equal(handback?.humanActionCount, humanActions.length);
  assert.doesNotMatch(run.raw, /Details/);
});

test('discovery: a stuck escalation whose operator input closes ends as aborted, not a hang', async () => {
  const run = await discover([{ kind: 'stuck', reason: 'cannot find the control' }], async () => 'input_closed');

  assert.equal(run.result.aborted, true);
  assert.equal(run.result.stuckReason, 'operator input closed before a decision');
  assert.equal(run.result.turns, 1);
  assert.equal(modelRequests.length, 1, 'no further model call after the operator input closed');
  assert.equal(run.events.find((event) => event.event === 'aborted')?.reason, 'operator input closed before a decision');
  assert.ok(!run.events.some((event) => event.event === 'handback'));
});
