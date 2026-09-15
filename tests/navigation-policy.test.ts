import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { replay } from '../src/replay.js';
import { DispatchGuard } from '../src/runtime.js';
import { createEvidenceWriter } from '../src/evidence.js';
import type { Capability, ReplayResult, Target } from '../src/schema.js';
import type { Profile } from '../src/profile.js';


let browser: Browser;
let app: Server;
let forbidden: Server;
let appOrigin = '';
let forbiddenOrigin = '';
let scratchEvidenceDir: string;
const appHits: string[] = [];
const forbiddenHits: string[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function homePage(): string {
  const f = forbiddenOrigin;
  return `<!doctype html><title>Home</title><h1>Home</h1>
<a href="/redirect-out">Redirect out</a>
<a href="/redirect-chain">Redirect chain</a>
<a href="/redirect-local">Redirect local</a>
<a href="/redirect-ok">Redirect ok</a>
<a href="/next" target="_blank">New tab</a>
<button onclick="location.href='${f}/leak-script'">Continue</button>
<form action="${f}/leak-static-form" method="get"><button>Look up</button></form>
<form action="/next" method="get" onsubmit="this.action='${f}/leak-dynamic-form'"><button>Find</button></form>
<button onclick="window.open('/next')">Details</button>
<button onclick="window.open('${f}/leak-popup')">Preview</button>`;
}

before(async () => {
  scratchEvidenceDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  forbidden = createServer((req, res) => {
    forbiddenHits.push(`${req.method} ${req.url}`);
    res.end('forbidden endpoint reached');
  });
  app = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    appHits.push(`${req.method} ${path}`);
    const redirects: Record<string, string> = {
      '/redirect-out': `${forbiddenOrigin}/leak-redirect`,
      '/redirect-chain': '/redirect-hop',
      '/redirect-hop': `${forbiddenOrigin}/leak-chain`,
      '/redirect-local': '/admin',
      '/redirect-ok': '/next',
    };
    const location = redirects[path];
    if (location) {
      res.writeHead(302, { location });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (path === '/') res.end(homePage());
    else if (path === '/next') res.end(`<!doctype html><h1>Next page</h1><img src="${forbiddenOrigin}/leak-image" alt="">`);
    else res.end('<!doctype html><h1>Other page</h1>');
  });
  forbiddenOrigin = await listen(forbidden);
  appOrigin = await listen(app);
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => forbidden.close(() => resolve()));
  rmSync(scratchEvidenceDir, { recursive: true, force: true });
});

const link = (name: string): Target => ({ strategies: [{ kind: 'role', role: 'link', name }], provenance: 'authored' });
const button = (name: string): Target => ({ strategies: [{ kind: 'role', role: 'button', name }], provenance: 'authored' });

function clickCapability(target: Target, postconditionText?: string): Capability {
  return {
    schemaVersion: '1.0.0',
    id: 'test.navigation-policy',
    version: '1.0.0',
    profileId: 'navigation-policy-test',
    goal: 'test',
    inputs: {},
    outputs: {},
    targets: { control: target },
    conditions: postconditionText ? { landed: { kind: 'pageContainsText', text: { literal: postconditionText } } } : {},
    steps: [
      { id: 'step-1-navigate', intent: 'open', action: { kind: 'navigate', path: '/' }, timeoutMs: 5000 },
      {
        id: 'step-2-click',
        intent: 'activate the control',
        action: { kind: 'click', targetRef: 'control' },
        timeoutMs: 5000,
        ...(postconditionText ? { postconditionRef: 'landed' } : {}),
      },
    ],
    blockers: [],
    discoveryProvenance: { mode: 'authored', note: 'test fixture' },
  };
}

async function runClick(target: Target, postconditionText?: string) {
  const profile: Profile = {
    id: 'navigation-policy-test',
    entryPath: '/',
    allowedOrigin: appOrigin,
    allowedRoutePatterns: [/^\/$/, /^\/next$/, /^\/redirect-[a-z]+$/],
  };
  appHits.length = 0;
  forbiddenHits.length = 0;
  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  try {
    const result = await replay(clickCapability(target, postconditionText), {}, profile, page, guard, evidence);
    for (let i = 0; i < 20 && page.context().pages().length > 1; i++) await new Promise((r) => setTimeout(r, 100));
    const raw = readFileSync(evidence.filePath, 'utf8');
    const events = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    return { result, raw, events, openPages: page.context().pages().length };
  } finally {
    await page.context().close();
  }
}

function assertPolicyBlocked(result: ReplayResult, observed: string | RegExp, effect: 'none' | 'unknown'): void {
  assert.equal(result.type, 'failure', JSON.stringify(result));
  if (result.type !== 'failure') return;
  assert.equal(result.step, 'step-2-click');
  assert.equal(result.category, 'POLICY_BLOCKED');
  if (typeof observed === 'string') assert.equal(result.observed, observed);
  else assert.match(result.observed, observed);
  assert.equal(result.effect, effect);
}

function assertNoDestinationInEvidence(raw: string): void {
  assert.doesNotMatch(raw, /leak-/, 'evidence must not carry the blocked URL');
  assert.ok(!raw.includes(forbiddenOrigin.replace('http://', '')), 'evidence must not carry the forbidden origin');
}

test('a click whose response redirects to another origin is blocked before the redirect is followed', async () => {
  const run = await runClick(link('Redirect out'));
  assertPolicyBlocked(run.result, 'ORIGIN_NOT_ALLOWED (network)', 'unknown');
  assert.deepEqual(forbiddenHits, [], 'the forbidden endpoint must receive no request');
  assert.ok(appHits.includes('GET /redirect-out'));
  const block = run.events.find((event) => event.event === 'policy_blocked');
  assert.equal(block?.redirect, true);
  assert.equal(block?.navigation, true);
  assertNoDestinationInEvidence(run.raw);
});

test('a redirect chain through an allowed hop is stopped at the forbidden hop, each hop fetched once', async () => {
  const run = await runClick(link('Redirect chain'));
  assertPolicyBlocked(run.result, 'ORIGIN_NOT_ALLOWED (network)', 'unknown');
  assert.deepEqual(forbiddenHits, []);
  assert.equal(appHits.filter((hit) => hit === 'GET /redirect-chain').length, 1);
  assert.equal(appHits.filter((hit) => hit === 'GET /redirect-hop').length, 1);
});

test('a same-origin redirect to a route outside the allowlist is blocked and that route receives no request', async () => {
  const run = await runClick(link('Redirect local'));
  assertPolicyBlocked(run.result, 'ROUTE_NOT_ALLOWED (network)', 'unknown');
  assert.ok(!appHits.includes('GET /admin'), 'the disallowed route must receive no request');
});

test('script-driven navigation off-origin is blocked at the network layer', async () => {
  const run = await runClick(button('Continue'));
  assertPolicyBlocked(run.result, 'ORIGIN_NOT_ALLOWED (network)', 'unknown');
  assert.deepEqual(forbiddenHits, []);
  assertNoDestinationInEvidence(run.raw);
});

test('a form retargeted off-origin at submit time is blocked at the network layer', async () => {
  const run = await runClick(button('Find'));
  assertPolicyBlocked(run.result, 'ORIGIN_NOT_ALLOWED (network)', 'unknown');
  assert.deepEqual(forbiddenHits, []);
  assert.ok(!appHits.includes('GET /next'));
});

test('a form whose static action is off-origin is refused before the click is dispatched', async () => {
  const run = await runClick(button('Look up'));
  assertPolicyBlocked(run.result, 'ORIGIN_NOT_ALLOWED (pre-dispatch)', 'none');
  assert.deepEqual(forbiddenHits, []);
});

test('popups: a script-opened window is closed and fails the step; an off-origin popup sends nothing; target=_blank is refused before dispatch', async () => {
  const allowedPopup = await runClick(button('Details'));
  assertPolicyBlocked(allowedPopup.result, 'POPUP_NOT_SUPPORTED (network)', 'unknown');
  assert.equal(allowedPopup.openPages, 1, 'automation must not leave a second window open');

  const forbiddenPopup = await runClick(button('Preview'));
  assertPolicyBlocked(forbiddenPopup.result, /^(POPUP_NOT_SUPPORTED|ORIGIN_NOT_ALLOWED) \(network\)$/, 'unknown');
  assert.deepEqual(forbiddenHits, [], 'the popup must not reach the forbidden endpoint');

  const newTab = await runClick(link('New tab'));
  assertPolicyBlocked(newTab.result, 'POPUP_NOT_SUPPORTED (pre-dispatch)', 'none');
  assert.ok(!appHits.includes('GET /next'), 'a refused target=_blank link must send no request');
});

test('an allowed redirect still completes; an off-origin subresource on the landing page is prevented without failing the step', async () => {
  const run = await runClick(link('Redirect ok'), 'Next page');
  assert.equal(run.result.type, 'success', JSON.stringify(run.result));
  assert.equal(appHits.filter((hit) => hit === 'GET /next').length, 1, 'the redirect target is fetched exactly once');
  assert.deepEqual(forbiddenHits, [], 'the off-origin image must not be requested');
  const imageBlock = run.events.find((event) => event.event === 'policy_blocked');
  assert.equal(imageBlock?.navigation, false);
  assert.equal(imageBlock?.code, 'ORIGIN_NOT_ALLOWED');
  assertNoDestinationInEvidence(run.raw);
});
