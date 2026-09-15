import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { DispatchGuard, OwnershipError, PageContextError, StaleActionError } from '../src/runtime.js';
import { verifyResumeState } from '../src/replay.js';
import type { Blocker, Capability } from '../src/schema.js';

function stubPage(): Page {
  return {} as unknown as Page;
}

test('scheduling is refused the instant a transfer is requested, and settles in-flight work first', async () => {
  const page = stubPage();
  const guard = new DispatchGuard('test-session', page);
  const epoch0 = guard.session.controlEpoch;

  let releaseInFlight: () => void = () => {};
  const inFlightGate = new Promise<void>((resolve) => {
    releaseInFlight = resolve;
  });

  const inFlight = guard.run(epoch0, page, async () => {
    await inFlightGate;
    return 'in-flight-completed';
  });

  const transferPromise = guard.pauseAndTransferToHuman();

  await assert.rejects(() => guard.run(epoch0, page, async () => 'must-not-run'), OwnershipError);

  releaseInFlight();
  const newEpoch = await transferPromise;

  assert.equal(await inFlight, 'in-flight-completed', 'work already in flight when transfer was requested must still complete');
  assert.equal(guard.session.owner, 'human');
  assert.equal(newEpoch, epoch0 + 1);

  await assert.rejects(() => guard.run(newEpoch, page, async () => 'nope'), OwnershipError);
});

test('a transfer settles every already-queued action, not just the one already running', async () => {
  const page = stubPage();
  const guard = new DispatchGuard('test-session-queue', page);
  const epoch0 = guard.session.controlEpoch;
  const completed: string[] = [];

  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = guard.run(epoch0, page, async () => {
    await firstGate;
    completed.push('first');
    return 'first';
  });
  const second = guard.run(epoch0, page, async () => {
    completed.push('second');
    return 'second';
  });

  const transferPromise = guard.pauseAndTransferToHuman();

  assert.deepEqual(completed, []);

  releaseFirst();
  await Promise.all([first, second]);
  await transferPromise;

  assert.deepEqual(completed, ['first', 'second'], 'both queued actions must run to completion, in order, before the transfer settles');
  assert.equal(guard.session.owner, 'human');
});

test('a stale action (old epoch, captured before a completed handback) is rejected even though automation owns control again', async () => {
  const page = stubPage();
  const guard = new DispatchGuard('test-session-stale', page);
  const epochBeforePause = guard.session.controlEpoch;

  await guard.pauseAndTransferToHuman();
  const handedBackEpoch = guard.handBackToAutomation();

  assert.equal(guard.session.owner, 'automation');
  assert.notEqual(handedBackEpoch, epochBeforePause, 'the epoch must have moved on');

  await assert.rejects(() => guard.run(epochBeforePause, page, async () => 'must-not-run'), StaleActionError);
  assert.equal(await guard.run(handedBackEpoch, page, async () => 'ok'), 'ok');
});

test('an action targeting a different page than the guard is bound to is rejected, even with valid ownership and epoch', async () => {
  const boundPage = stubPage();
  const otherPage = stubPage();
  const guard = new DispatchGuard('test-session-page-binding', boundPage);
  const epoch0 = guard.session.controlEpoch;

  await assert.rejects(() => guard.run(epoch0, otherPage, async () => 'must-not-run'), PageContextError);
  assert.equal(await guard.run(epoch0, boundPage, async () => 'ok'), 'ok');
});

function makeCapability(blockerSignatureText: string, checkpointText: string): Capability {
  return {
    schemaVersion: '1.0.0',
    id: 'test.capability',
    version: '1.0.0',
    profileId: 'demo',
    goal: 'test',
    inputs: {},
    outputs: {},
    targets: {},
    conditions: {
      signature: { kind: 'pageContainsText', text: { literal: blockerSignatureText } },
      checkpoint: { kind: 'pageContainsText', text: { literal: checkpointText } },
    },
    steps: [{ id: 'step-1', intent: 'test', action: { kind: 'navigate', path: '/' }, timeoutMs: 1000 }],
    blockers: [],
    discoveryProvenance: { mode: 'authored', note: 'test fixture' },
  };
}

const blocker: Blocker = { signatureRef: 'signature', classification: 'intervention', reasonCode: 'TEST' };

test('verifyResumeState stays paused (ok:false) when the blocker signature is still present', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<p>Session Expired - please sign in</p>');
    const capability = makeCapability('Session Expired', 'Member Detail');

    const result = await verifyResumeState(page, capability, {}, blocker, 'checkpoint');
    assert.equal(result.ok, false);
    assert.equal(result.stillBlocked, true);
  } finally {
    await browser.close();
  }
});

test('verifyResumeState stays paused (ok:false) when the declared checkpoint does not hold, even if the blocker is gone', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<p>Some other unrelated screen</p>');
    const capability = makeCapability('Session Expired', 'Member Detail');

    const result = await verifyResumeState(page, capability, {}, blocker, 'checkpoint');
    assert.equal(result.ok, false);
    assert.equal(result.stillBlocked, false);
    assert.equal(result.checkpointOk, false);
  } finally {
    await browser.close();
  }
});

test('verifyResumeState resumes (ok:true) once the blocker is gone and the checkpoint holds', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<p>Member Detail loaded fine</p>');
    const capability = makeCapability('Session Expired', 'Member Detail');

    const result = await verifyResumeState(page, capability, {}, blocker, 'checkpoint');
    assert.equal(result.ok, true);
  } finally {
    await browser.close();
  }
});

test('verifyResumeState reports SESSION_LOST when the page is closed', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<p>anything</p>');
    const capability = makeCapability('Session Expired', 'Member Detail');
    await page.close();

    const result = await verifyResumeState(page, capability, {}, blocker, 'checkpoint');
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'SESSION_LOST');
  } finally {
    await browser.close();
  }
});
