import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { listCapabilities, resolveCapabilityPath } from '../src/catalog.js';
import { CURATED_CAPABILITY_PATH } from '../src/discovery.js';

test('listCapabilities() lists the curated artifact with its typed contract (id, version, goal, inputs, outputs)', () => {
  const entries = listCapabilities();
  const curated = entries.find((e) => e.path === CURATED_CAPABILITY_PATH);
  assert.ok(curated, 'the curated capability must be listed');
  assert.equal(curated!.status, 'ok');
  if (curated!.status === 'ok') {
    assert.equal(curated!.id, 'member.balance.read');
    assert.equal(curated!.version, '1.2.0');
    assert.match(curated!.goal, /savings account/);
    assert.deepEqual(Object.keys(curated!.inputs), ['memberId']);
    assert.deepEqual(Object.keys(curated!.outputs).sort(), ['balance', 'currency', 'status']);
  }
});

test('listCapabilities() never lists anything under capabilities/generated/, even a file that shadows the curated id and version exactly', () => {
  mkdirSync('capabilities/generated', { recursive: true });
  const shadowPath = 'capabilities/generated/shadow-test.json';
  try {
    const curated = JSON.parse(readFileSync(CURATED_CAPABILITY_PATH, 'utf8'));
    writeFileSync(shadowPath, JSON.stringify(curated));

    const entries = listCapabilities();
    assert.ok(
      entries.every((e) => !e.path.startsWith('capabilities/generated/')),
      'no entry should ever come from capabilities/generated/',
    );

    const resolved = resolveCapabilityPath(curated.id, curated.version);
    assert.equal(resolved, CURATED_CAPABILITY_PATH);
  } finally {
    rmSync(shadowPath, { force: true });
  }
});

test('resolveCapabilityPath() resolves an explicit id+version to the curated file, never a fuzzy or "latest" match', () => {
  const path = resolveCapabilityPath('member.balance.read', '1.2.0');
  assert.equal(path, CURATED_CAPABILITY_PATH);
});

test('resolveCapabilityPath() throws a clear error for an unknown id/version rather than guessing', () => {
  assert.throws(() => resolveCapabilityPath('member.balance.read', '9.9.9'), /No curated capability found/);
  assert.throws(() => resolveCapabilityPath('not.a.real.capability', '1.0.0'), /No curated capability found/);
});

test('a malformed file under capabilities/ is reported as an invalid entry, not thrown or silently dropped', () => {
  const badPath = 'capabilities/bad-test.json';
  try {
    writeFileSync(badPath, JSON.stringify({ not: 'a capability' }));
    const entries = listCapabilities();
    const bad = entries.find((e) => e.path === badPath);
    assert.ok(bad, 'the malformed file must still appear in the listing');
    assert.equal(bad!.status, 'invalid');
  } finally {
    rmSync(badPath, { force: true });
  }
});

test('invoke dispatches through the same verified runtime as replay - one browser launch site, not a second execution path', () => {
  const source = readFileSync('src/cli.ts', 'utf8');
  const launches = source.match(/chromium\.launch/g) ?? [];
  assert.equal(launches.length, 2, 'exactly one launch for discover, one shared by replay and invoke via executeReplay');
  assert.match(source, /runInvokeCommand[\s\S]*?executeReplay\(/, 'invoke must call the same executeReplay replay uses');
});
