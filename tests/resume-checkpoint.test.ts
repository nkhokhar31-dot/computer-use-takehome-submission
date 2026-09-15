import { test, before, after } from 'node:test';
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
import type { OperatorDecision } from '../src/operator.js';
import type { Capability } from '../src/schema.js';
import type { Profile } from '../src/profile.js';

let browser: Browser;
let app: Server;
let appOrigin = '';
let gateCleared = false;
let scratchEvidenceDir: string;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  scratchEvidenceDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  app = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/') {
      res.end('<!doctype html><h1>Home</h1><a href="/record">Open record</a>');
    } else if (url.pathname === '/record') {
      res.end('<!doctype html><h1>Record detail</h1><a href="/gate">Continue</a>');
    } else if (url.pathname === '/gate') {
      res.end(
        gateCleared
          ? '<!doctype html><h1>Gate cleared</h1>'
          : '<!doctype html><h1>Please Wait</h1><a href="/final?cleared=1">Skip ahead</a>',
      );
    } else if (url.pathname === '/final') {
      if (url.searchParams.get('cleared') === '1') gateCleared = true;
      res.end('<!doctype html><h1>All done</h1>');
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  appOrigin = await listen(app);
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  rmSync(scratchEvidenceDir, { recursive: true, force: true });
});

const capability: Capability = {
  schemaVersion: '1.0.0',
  id: 'test.resume-checkpoint',
  version: '1.0.0',
  profileId: 'resume-checkpoint-test',
  goal: 'test',
  inputs: {},
  outputs: {},
  targets: {
    openRecord: { strategies: [{ kind: 'role', role: 'link', name: 'Open record' }], provenance: 'authored' },
    continueLink: { strategies: [{ kind: 'role', role: 'link', name: 'Continue' }], provenance: 'authored' },
  },
  conditions: {
    recordLoaded: { kind: 'pageContainsText', text: { literal: 'Record detail' } },
    gateSignature: { kind: 'pageContainsText', text: { literal: 'Please Wait' } },
  },
  steps: [
    { id: 'step-1-navigate', intent: 'open', action: { kind: 'navigate', path: '/' }, timeoutMs: 5000 },
    {
      id: 'step-2-click',
      intent: 'open the record',
      action: { kind: 'click', targetRef: 'openRecord' },
      postconditionRef: 'recordLoaded',
      timeoutMs: 5000,
    },
    {
      id: 'step-3-click',
      intent: 'continue',
      action: { kind: 'click', targetRef: 'continueLink' },
      timeoutMs: 5000,
    },
  ],
  blockers: [{ signatureRef: 'gateSignature', classification: 'intervention', reasonCode: 'GATE_PENDING' }],
  discoveryProvenance: { mode: 'authored', note: 'test fixture' },
};

test("resume succeeds once the blocker clears on a checkpoint-less step, even though the page has moved on from an earlier step's checkpoint", async () => {
  gateCleared = false;
  const profile: Profile = {
    id: 'resume-checkpoint-test',
    entryPath: '/',
    allowedOrigin: appOrigin,
    allowedRoutePatterns: [/^\/$/, /^\/record$/, /^\/gate$/, /^\/final$/],
  };
  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  let promptCalls = 0;

  const operatorPrompt = async (): Promise<OperatorDecision> => {
    promptCalls++;
    if (promptCalls === 1) {
      return 'resume';
    }
    if (promptCalls === 2) {
      await page.getByRole('link', { name: 'Skip ahead' }).click();
      await page.waitForLoadState('load');
      return 'resume';
    }
    return 'abort';
  };

  try {
    const result = await replay(capability, {}, profile, page, guard, evidence, { operatorPrompt });
    assert.equal(result.type, 'success', JSON.stringify(result));
    assert.equal(
      promptCalls,
      2,
      'expected exactly one wrong-state rejection, then a resume that succeeds once the blocker itself clears',
    );
  } finally {
    await page.context().close();
  }
});
