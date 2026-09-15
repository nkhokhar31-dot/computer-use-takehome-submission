import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { replay } from '../src/replay.js';
import { DispatchGuard } from '../src/runtime.js';
import { createEvidenceWriter } from '../src/evidence.js';
import type { Capability } from '../src/schema.js';
import type { Profile } from '../src/profile.js';

let server: Server;
let browser: Browser;
let origin: string;
let scratchEvidenceDir: string;

test.before(async () => {
  scratchEvidenceDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<button>Click Me</button><button>Click Me</button>');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

test.after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratchEvidenceDir, { recursive: true, force: true });
});

test('two controls matching the same declared locator strategy produce TARGET_AMBIGUOUS, not an arbitrary click', async () => {
  const profile: Profile = {
    id: 'ambiguous-test',
    entryPath: '/',
    allowedOrigin: origin,
    allowedRoutePatterns: [/^\/$/],
  };

  const capability: Capability = {
    schemaVersion: '1.0.0',
    id: 'test.ambiguous',
    version: '1.0.0',
    profileId: profile.id,
    goal: 'test',
    inputs: {},
    outputs: {},
    targets: {
      duplicateButton: { strategies: [{ kind: 'role', role: 'button', name: 'Click Me' }], provenance: 'authored' },
    },
    conditions: {},
    steps: [
      { id: 'step-1-navigate', intent: 'open', action: { kind: 'navigate', path: '/' }, timeoutMs: 3000 },
      { id: 'step-2-click', intent: 'click the ambiguous button', action: { kind: 'click', targetRef: 'duplicateButton' }, timeoutMs: 3000 },
    ],
    blockers: [],
    discoveryProvenance: { mode: 'authored', note: 'test fixture' },
  };

  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  try {
    const result = await replay(capability, {}, profile, page, guard, evidence);
    assert.equal(result.type, 'failure');
    if (result.type === 'failure') {
      assert.equal(result.category, 'TARGET_AMBIGUOUS');
      assert.equal(result.step, 'step-2-click');
      assert.match(result.observed, /2 matches/);
    }
  } finally {
    await page.close();
  }
});
