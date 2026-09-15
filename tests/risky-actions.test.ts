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
import { DispatchGuard, classifyClick } from '../src/runtime.js';
import { createEvidenceWriter } from '../src/evidence.js';
import type { Capability, ReplayResult } from '../src/schema.js';
import type { Profile } from '../src/profile.js';


let browser: Browser;
let server: Server;
let origin = '';
let scratchEvidenceDir: string;
const hits: string[] = [];

before(async () => {
  scratchEvidenceDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits.push(`${req.method} ${path}`);
    res.setHeader('content-type', 'text/html');
    if (path !== '/') {
      res.end('<!doctype html><h1>Done</h1>');
      return;
    }
    res.end(`<!doctype html><h1>Account</h1>
<form action="/mutate" method="get"><button>Transfer funds</button></form>
<form action="/mutate" method="get"><button>Confirm payment</button></form>
<form action="/mutate" method="post"><button>Continue</button></form>
<button onclick="fetch('/mutate', { method: 'POST' })">Refresh</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratchEvidenceDir, { recursive: true, force: true });
});

async function clickButton(name: string, intent = 'activate the control') {
  const profile: Profile = { id: 'risky-test', entryPath: '/', allowedOrigin: origin, allowedRoutePatterns: [/^\/$/, /^\/mutate$/] };
  const capability: Capability = {
    schemaVersion: '1.0.0',
    id: 'test.risky',
    version: '1.0.0',
    profileId: profile.id,
    goal: 'test',
    inputs: {},
    outputs: {},
    targets: { control: { strategies: [{ kind: 'role', role: 'button', name }], provenance: 'authored' } },
    conditions: {},
    steps: [
      { id: 'step-1-navigate', intent: 'open', action: { kind: 'navigate', path: '/' }, timeoutMs: 5000 },
      { id: 'step-2-click', intent, action: { kind: 'click', targetRef: 'control' }, timeoutMs: 5000 },
    ],
    blockers: [],
    discoveryProvenance: { mode: 'authored', note: 'test fixture' },
  };
  hits.length = 0;
  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  try {
    const result = await replay(capability, {}, profile, page, guard, evidence);
    const raw = readFileSync(evidence.filePath, 'utf8');
    return { result, raw, events: raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) };
  } finally {
    await page.context().close();
  }
}

function assertBlocked(result: ReplayResult, observed: string, effect: 'none' | 'unknown'): void {
  assert.equal(result.type, 'failure', JSON.stringify(result));
  if (result.type !== 'failure') return;
  assert.equal(result.category, 'POLICY_BLOCKED');
  assert.equal(result.step, 'step-2-click');
  assert.equal(result.observed, observed);
  assert.equal(result.effect, effect);
}

const mutatingHits = () => hits.filter((hit) => hit.endsWith(' /mutate'));

test('a control whose live label is risky is refused before dispatch, and its endpoint receives no request', async () => {
  const run = await clickButton('Transfer funds');
  assertBlocked(run.result, 'RISKY_CONTROL (pre-dispatch)', 'none');
  assert.deepEqual(mutatingHits(), []);
  const block = run.events.find((event) => event.event === 'policy_blocked');
  assert.equal(block?.matchedTerm, 'transfer');
  assert.doesNotMatch(run.raw, /Transfer funds/, 'evidence records the matched term, never the control text');
});

test('an artifact describing a risky step as safe does not bypass the check - the live DOM decides', async () => {
  const run = await clickButton('Confirm payment', 'Safe, read-only: view the statement');
  assertBlocked(run.result, 'RISKY_CONTROL (pre-dispatch)', 'none');
  assert.deepEqual(mutatingHits(), []);
});

test('a neutrally-labelled button that submits a POST form is refused before dispatch', async () => {
  const run = await clickButton('Continue');
  assertBlocked(run.result, 'UNSAFE_METHOD (pre-dispatch)', 'none');
  assert.deepEqual(mutatingHits(), []);
});

test('a state-changing request made by page script after an innocuous click is blocked at the network layer', async () => {
  const run = await clickButton('Refresh');
  assertBlocked(run.result, 'UNSAFE_METHOD (network)', 'unknown');
  assert.deepEqual(mutatingHits(), [], 'the POST must never reach the server');
});

test('classifyClick: whole-word, case-insensitive risky terms; ordinary read-only labels pass', () => {
  const facts = (label: string) => ({ label, submitsForm: false, opensNewWindow: false });
  for (const label of ['DELETE', 'Confirm   payment', 'Wire money', 'Close account']) {
    assert.equal(classifyClick(facts(label), undefined)?.code, 'RISKY_CONTROL', label);
  }
  for (const label of ['Search', 'Savings - S-2001', 'Sign in again', 'Payment history', 'Display settings']) {
    assert.equal(classifyClick(facts(label), undefined), null, label);
  }
});
