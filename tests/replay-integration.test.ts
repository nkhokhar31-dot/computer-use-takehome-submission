import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { replay } from '../src/replay.js';
import { DispatchGuard } from '../src/runtime.js';
import { loadProfile } from '../src/profile.js';
import { createEvidenceWriter } from '../src/evidence.js';
import { parseCapability, type Capability } from '../src/schema.js';
import { app, resetFaultStateForTests } from '../target-app/server.js';

let server: Server;
let browser: Browser;
let appOrigin: string;
let capability: Capability;
let scratchEvidenceDir: string;

before(async () => {
  scratchEvidenceDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  appOrigin = `http://localhost:${(server.address() as AddressInfo).port}`;
  process.env.APP_ORIGIN = appOrigin;
  browser = await chromium.launch();
  capability = parseCapability(JSON.parse(readFileSync('capabilities/member.balance.read.v1.json', 'utf8')));
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratchEvidenceDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetFaultStateForTests();
});

async function runReplay(inputs: Record<string, string>, capabilityOverride?: Capability) {
  const profile = loadProfile('demo');
  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  try {
    return await replay(capabilityOverride ?? capability, inputs, profile, page, guard, evidence);
  } finally {
    await page.close();
  }
}

test('changed-input replay: two different members produce two different, correct outputs with the same artifact', async () => {
  const a = await runReplay({ memberId: '00123' });
  const b = await runReplay({ memberId: '00456' });

  assert.equal(a.type, 'success');
  assert.equal(b.type, 'success');
  if (a.type === 'success' && b.type === 'success') {
    assert.equal(a.outputs.balance, '4231.50');
    assert.equal(b.outputs.balance, '812.09');
    assert.notEqual(a.outputs.balance, b.outputs.balance, 'changed input must change the output, not replay a cached/fixed value');
  }
});

test('business outcome: a missing member returns MEMBER_NOT_FOUND, not a generic failure', async () => {
  const result = await runReplay({ memberId: '00999' });
  assert.equal(result.type, 'business_outcome');
  if (result.type === 'business_outcome') {
    assert.equal(result.code, 'MEMBER_NOT_FOUND');
  }
});

test('bounded recovery: a transient loading state resolves within the declared bound', async () => {
  const result = await runReplay({ memberId: '00600' });
  assert.equal(result.type, 'success');
  if (result.type === 'success') {
    assert.equal(result.outputs.balance, '990.15');
  }
});

test('bounded recovery exhaustion: too tight a bound reports a clean POSTCONDITION_FAILED, not an infinite loop or a crash', async () => {
  const tightened: Capability = JSON.parse(JSON.stringify(capability));
  const savingsStep = tightened.steps.find((s) => s.postconditionRecovery);
  assert.ok(savingsStep, 'expected the compiled capability to declare a postconditionRecovery step');
  savingsStep!.postconditionRecovery = { maxAttempts: 1, delayMs: 50 };

  const result = await runReplay({ memberId: '00600' }, tightened);
  assert.equal(result.type, 'failure');
  if (result.type === 'failure') {
    assert.equal(result.category, 'POSTCONDITION_FAILED');
  }
});

test('policy enforcement: a step declaring a navigate path outside the allowlisted routes is refused, not silently followed', async () => {
  const withDisallowedNavigate: Capability = JSON.parse(JSON.stringify(capability));
  withDisallowedNavigate.steps = [
    { id: 'step-1-navigate', intent: 'test', action: { kind: 'navigate', path: '/not-an-allowed-route' }, timeoutMs: 3000 },
  ];
  withDisallowedNavigate.outputs = {};

  const result = await runReplay({ memberId: '00123' }, withDisallowedNavigate);
  assert.equal(result.type, 'failure');
  if (result.type === 'failure') {
    assert.match(result.observed, /Refusing navigation/);
  }
});

test('policy enforcement: a click that navigates outside the allowlisted routes reports POLICY_BLOCKED, not a generic driver error', async () => {
  const profile = loadProfile('demo');
  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  try {
    await page.goto(`${appOrigin}/member/00123`);
    await page.setContent('<a href="/not-an-allowed-route">Escape</a>');

    const escapeCapability: Capability = JSON.parse(JSON.stringify(capability));
    escapeCapability.steps = [
      { id: 'step-1-click', intent: 'test', action: { kind: 'click', targetRef: 'escapeTarget' }, timeoutMs: 3000 },
    ];
    escapeCapability.targets = { escapeTarget: { strategies: [{ kind: 'role', role: 'link', name: 'Escape' }], provenance: 'authored' } };
    escapeCapability.outputs = {};

    const guard = new DispatchGuard(randomUUID(), page);
    const result = await replay(escapeCapability, { memberId: '00123' }, profile, page, guard, evidence);

    assert.equal(result.type, 'failure');
    if (result.type === 'failure') {
      assert.equal(result.category, 'POLICY_BLOCKED');
      assert.equal(result.effect, 'unknown', 'the navigation was refused at the network layer before it completed');
    }
  } finally {
    await page.close();
  }
});

test('hard failure evidence ends with its own terminal step_result event, not just the blocker event', async () => {
  const profile = loadProfile('demo');
  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  try {
    const result = await replay(capability, { memberId: '00700' }, profile, page, guard, evidence);
    assert.equal(result.type, 'failure');
    if (result.type === 'failure') {
      assert.equal(result.category, 'APPLICATION_ERROR');
    }

    const events = readFileSync(evidence.filePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const blockerIndex = events.findIndex((e) => e.event === 'blocker');
    assert.ok(blockerIndex >= 0, 'expected a blocker event to have been recorded');
    const blockerStepId = events[blockerIndex]!.stepId;
    const terminalIndex = events.findIndex(
      (e, i) => i > blockerIndex && e.event === 'step_result' && e.stepId === blockerStepId,
    );
    assert.ok(
      terminalIndex > blockerIndex,
      'a hard-failure blocker must be followed by its own step_result event, not leave the run ending on the blocker event alone',
    );
    assert.equal(events[terminalIndex]!.outcome, 'failure');
  } finally {
    await page.close();
  }
});

test('replay never imports the Anthropic SDK - static check for the zero-model-calls architectural boundary', () => {
  const source = readFileSync(new URL('../src/replay.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /@anthropic-ai\/sdk/);
});

test('replay succeeds with no ANTHROPIC_API_KEY configured at all - runtime proof of zero model calls', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await runReplay({ memberId: '00123' });
    assert.equal(result.type, 'success');
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('privacy: the committed capability artifact contains no member names or account ids from any known member', () => {
  const raw = readFileSync('capabilities/member.balance.read.v1.json', 'utf8');
  for (const leaked of ['Ava Thompson', 'Marcus Lee', 'Priya Natarajan', 'Jordan Reyes', 'Sam Okafor', 'Riley Chen', 'Savings - S-']) {
    assert.doesNotMatch(raw, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
