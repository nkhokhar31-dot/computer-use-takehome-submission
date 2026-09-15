import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { replay } from '../src/replay.js';
import { DispatchGuard } from '../src/runtime.js';
import { createEvidenceWriter, type EvidenceWriter } from '../src/evidence.js';
import type { Capability, ReplayResult } from '../src/schema.js';
import type { Profile } from '../src/profile.js';


let server: Server;
let origin = '';
let scratchEvidenceDir: string;
const hits: string[] = [];
const held: ServerResponse[] = [];
let onSlowRequest: () => void = () => {};

before(async () => {
  scratchEvidenceDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits.push(`${req.method} ${path}`);
    res.setHeader('content-type', 'text/html');
    if (path === '/slow') {
      held.push(res);
      onSlowRequest();
      return;
    }
    if (path === '/next') {
      res.end('<!doctype html><h1>Next</h1><p><span>Value</span><span>42</span></p>');
      return;
    }
    res.end('<!doctype html><h1>Home</h1><a href="/slow">Slow</a> <a href="/next">Next</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const res of held) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratchEvidenceDir, { recursive: true, force: true });
});

const profile = (): Profile => ({
  id: 'browser-loss-test',
  entryPath: '/',
  allowedOrigin: origin,
  allowedRoutePatterns: [/^\/$/, /^\/slow$/, /^\/next$/],
});

function capability(linkName: string): Capability {
  return {
    schemaVersion: '1.0.0',
    id: 'test.browser-loss',
    version: '1.0.0',
    profileId: 'browser-loss-test',
    goal: 'test',
    inputs: {},
    outputs: { value: { type: 'string', sensitivity: 'public', description: 'test' } },
    targets: {
      link: { strategies: [{ kind: 'role', role: 'link', name: linkName }], provenance: 'authored' },
      value: { strategies: [{ kind: 'nearbyText', labelText: 'Value' }], provenance: 'authored' },
    },
    conditions: {},
    steps: [
      { id: 'step-1-navigate', intent: 'open', action: { kind: 'navigate', path: '/' }, timeoutMs: 8000 },
      { id: 'step-2-click', intent: 'follow the link', action: { kind: 'click', targetRef: 'link' }, timeoutMs: 8000 },
      { id: 'step-3-extract', intent: 'read the value', action: { kind: 'extract', targetRef: 'value', outputRef: 'value' }, timeoutMs: 8000 },
    ],
    blockers: [],
    discoveryProvenance: { mode: 'authored', note: 'test fixture' },
  };
}

function readEvents(evidence: EvidenceWriter): Array<Record<string, unknown>> {
  return readFileSync(evidence.filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertSessionLost(result: ReplayResult, step: string, effect: 'none' | 'unknown'): void {
  assert.equal(result.type, 'failure', JSON.stringify(result));
  if (result.type !== 'failure') return;
  assert.equal(result.step, step);
  assert.equal(result.category, 'SESSION_LOST');
  assert.equal(result.effect, effect);
  assert.equal(result.expected, 'browser session alive');
  assert.doesNotMatch(result.observed, /\n|Call log/, 'observed is a sanitized one-line detail, not a raw Playwright error');
}

test('page closed while a click navigation is in flight: structured SESSION_LOST at the click, effect unknown, not retried', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  const evidence = createEvidenceWriter('replay');
  hits.length = 0;
  onSlowRequest = () => setTimeout(() => page.close().catch(() => {}), 200);
  try {
    const result = await replay(capability('Slow'), {}, profile(), page, guard, evidence);

    assertSessionLost(result, 'step-2-click', 'unknown');
    assert.equal(hits.filter((hit) => hit === 'GET /slow').length, 1, 'an action whose effect is unknown is never re-dispatched');
    const events = readEvents(evidence);
    assert.ok(!events.some((event) => event.stepId === 'step-3-extract'), 'replay stops at the failed step');
    assert.deepEqual(
      events.filter((event) => event.event === 'step_result').map((event) => [event.stepId, event.outcome]),
      [['step-1-navigate', 'success'], ['step-2-click', 'failure']],
    );
  } finally {
    onSlowRequest = () => {};
    await browser.close().catch(() => {});
  }
});

test('browser closed between steps: structured SESSION_LOST at the next step, effect none', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  const base = createEvidenceWriter('replay');
  hits.length = 0;
  const evidence: EvidenceWriter = {
    ...base,
    record(event) {
      base.record(event);
      const recorded = event as Record<string, unknown>;
      if (recorded.event === 'step_result' && recorded.stepId === 'step-2-click' && recorded.outcome === 'success') {
        void guard.run(guard.session.controlEpoch, page, () => browser.close());
      }
    },
  };
  try {
    const result = await replay(capability('Next'), {}, profile(), page, guard, evidence);

    assertSessionLost(result, 'step-3-extract', 'none');
    assert.equal(hits.filter((hit) => hit === 'GET /next').length, 1);
    assert.deepEqual(
      readEvents(evidence).filter((event) => event.event === 'step_result').map((event) => [event.stepId, event.outcome]),
      [['step-1-navigate', 'success'], ['step-2-click', 'success'], ['step-3-extract', 'failure']],
    );
  } finally {
    await browser.close().catch(() => {});
  }
});
