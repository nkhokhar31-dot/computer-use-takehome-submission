import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { replay } from '../src/replay.js';
import { resolveTarget } from '../src/browser.js';
import { DispatchGuard } from '../src/runtime.js';
import { loadProfile, type Profile } from '../src/profile.js';
import { createEvidenceWriter } from '../src/evidence.js';
import { parseCapability, type Capability } from '../src/schema.js';
import { createApp } from '../target-app/server.js';

let server: Server;
let browser: Browser;
let profile: Profile;
let capability: Capability;
let scratchEvidenceDir: string;

before(async () => {
  scratchEvidenceDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  server = createApp('legacy').listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  process.env.APP_ORIGIN = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  profile = loadProfile('demo');
  capability = parseCapability(JSON.parse(readFileSync('capabilities/member.balance.read.v1.json', 'utf8')));
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratchEvidenceDir, { recursive: true, force: true });
});

test("legacy mode: the Member ID target's rank-1 label strategy genuinely returns zero, and its declared rank-2 nearbyText fallback resolves exactly one control", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${profile.allowedOrigin}/`);

    const memberIdTarget = capability.targets.target1;
    assert.ok(memberIdTarget, 'expected the artifact to declare target1 for the Member ID field');
    assert.equal(memberIdTarget.strategies[0]?.kind, 'label', 'rank-1 must still be the label strategy');
    assert.equal(memberIdTarget.strategies[1]?.kind, 'nearbyText', 'rank-2 must be the declared fallback');

    assert.equal(await page.getByLabel('Member ID', { exact: true }).count(), 0);

    const resolution = await resolveTarget(page, memberIdTarget);
    assert.equal(resolution.outcome, 'resolved');
    if (resolution.outcome === 'resolved') {
      assert.equal(resolution.strategyIndex, 1, 'must resolve via the rank-2 fallback, not rank-1');
      assert.equal(resolution.strategy.kind, 'nearbyText');
    }
  } finally {
    await page.close();
  }
});

test('legacy mode: the unmodified v1.2.0 artifact replays end-to-end against the legacy DOM (table-based savings values, no artifact change)', async () => {
  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  try {
    const result = await replay(capability, { memberId: '00123' }, profile, page, guard, evidence);
    assert.equal(result.type, 'success');
    if (result.type === 'success') {
      assert.equal(result.outputs.balance, '4231.50');
      assert.equal(result.outputs.currency, 'USD');
      assert.equal(result.outputs.status, 'Active');
    }
  } finally {
    await page.close();
  }
});
