import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { replay } from '../src/replay.js';
import { DispatchGuard } from '../src/runtime.js';
import { createEvidenceWriter } from '../src/evidence.js';
import { promptResumeOrAbort } from '../src/operator.js';
import type { Capability } from '../src/schema.js';
import type { Profile } from '../src/profile.js';


const sink = () => new PassThrough().resume();

test('promptResumeOrAbort returns input_closed when the input has already ended', async () => {
  const input = new PassThrough();
  input.end();
  input.resume();
  await once(input, 'end');
  assert.equal(await promptResumeOrAbort(input, sink()), 'input_closed');
});

test('promptResumeOrAbort returns input_closed when the input closes while waiting', async () => {
  const input = new PassThrough();
  const decision = promptResumeOrAbort(input, sink());
  setTimeout(() => input.end(), 20);
  assert.equal(await decision, 'input_closed');
});

test('promptResumeOrAbort still returns an explicit decision that arrives before EOF', async () => {
  const aborted = new PassThrough();
  aborted.end('abort\n');
  assert.equal(await promptResumeOrAbort(aborted, sink()), 'abort');

  const resumed = new PassThrough();
  const decision = promptResumeOrAbort(resumed, sink());
  resumed.write('something else\n');
  resumed.write('  RESUME \n');
  assert.equal(await decision, 'resume');
  resumed.end();
});

test('the prompt line is ended before the caller prints its result, for piped decisions and for EOF', async () => {
  for (const [feed, expected] of [['abort\n', 'abort'], ['', 'input_closed']] as const) {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => (written += chunk));
    input.end(feed);
    assert.equal(await promptResumeOrAbort(input, output), expected);
    assert.ok(written.endsWith('\n'), `output for ${expected} must end its line, got ${JSON.stringify(written)}`);
  }
});

test('a second prompt on input a first prompt consumed to EOF returns input_closed', async () => {
  const input = new PassThrough();
  input.end('resume\n');
  assert.equal(await promptResumeOrAbort(input, sink()), 'resume');
  assert.equal(await promptResumeOrAbort(input, sink()), 'input_closed');
});

let browser: Browser;
let server: Server;
let origin = '';
let scratchEvidenceDir: string;

before(async () => {
  scratchEvidenceDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><h1>Session Expired</h1><a href="/">Sign in again</a>');
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

test('replay: an intervention whose operator input closes returns a structured aborted result', { timeout: 20_000 }, async () => {
  const profile: Profile = { id: 'input-closed-test', entryPath: '/', allowedOrigin: origin, allowedRoutePatterns: [/^\/$/] };
  const capability: Capability = {
    schemaVersion: '1.0.0',
    id: 'test.input-closed',
    version: '1.0.0',
    profileId: profile.id,
    goal: 'test',
    inputs: {},
    outputs: {},
    targets: {},
    conditions: { sessionExpired: { kind: 'pageContainsText', text: { literal: 'Session Expired' } } },
    steps: [{ id: 'step-1-navigate', intent: 'open', action: { kind: 'navigate', path: '/' }, timeoutMs: 5000 }],
    blockers: [{ signatureRef: 'sessionExpired', classification: 'intervention', reasonCode: 'SESSION_EXPIRED' }],
    discoveryProvenance: { mode: 'authored', note: 'test fixture' },
  };

  const input = new PassThrough();
  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  try {
    const result = await replay(capability, {}, profile, page, guard, evidence, {
      operatorPrompt: () => {
        const decision = promptResumeOrAbort(input, sink());
        input.end();
        return decision;
      },
    });

    assert.deepEqual(
      { ...result, interventionId: undefined },
      { type: 'aborted', step: 'step-1-navigate', interventionId: undefined, reason: 'operator input closed before a decision' },
    );
    assert.equal(guard.session.lifecycle, 'aborted');

    const events = readFileSync(evidence.filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const names = events.map((event) => event.event);
    assert.ok(names.indexOf('intervention_required') < names.indexOf('aborted'));
    assert.ok(!names.includes('handback'));
    assert.equal(events.find((event) => event.event === 'aborted')?.reason, 'operator input closed before a decision');
  } finally {
    await page.context().close();
  }
});
