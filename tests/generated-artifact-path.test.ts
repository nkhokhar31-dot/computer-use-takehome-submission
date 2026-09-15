import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CURATED_CAPABILITY_PATH,
  assertNotCuratedPath,
  generatedCapabilityPath,
} from '../src/discovery.js';
import { parseCapability } from '../src/schema.js';


const RUN_ID = 'discover-2026-09-14T14-41-21-000Z-5ee914df';

test('generated discovery output never lands on the curated capability path', () => {
  const generated = generatedCapabilityPath('member.balance.read', '1.1.0', RUN_ID);
  assert.notEqual(resolve(generated), resolve(CURATED_CAPABILITY_PATH));
  assert.match(generated, /^capabilities\/generated\//);
});

test('generated paths are per-run, so a second discovery run cannot clobber the first', () => {
  const first = generatedCapabilityPath('member.balance.read', '1.1.0', RUN_ID);
  const second = generatedCapabilityPath('member.balance.read', '1.1.0', 'discover-other-run-0000');
  assert.notEqual(first, second);
});

test('assertNotCuratedPath refuses the curated artifact under every spelling of its path', () => {
  for (const spelling of [
    CURATED_CAPABILITY_PATH,
    `./${CURATED_CAPABILITY_PATH}`,
    resolve(CURATED_CAPABILITY_PATH),
    'capabilities/../capabilities/member.balance.read.v1.json',
  ]) {
    assert.throws(() => assertNotCuratedPath(spelling), /Refusing to write discovery output/);
  }
});

test('assertNotCuratedPath allows a generated path', () => {
  assert.doesNotThrow(() => assertNotCuratedPath(generatedCapabilityPath('member.balance.read', '1.1.0', RUN_ID)));
});

test('the discover CLI writes only via generatedCapabilityPath - no literal curated path', () => {
  const source = readFileSync('src/cli.ts', 'utf8');
  assert.match(source, /generatedCapabilityPath\(/);
  assert.match(source, /assertNotCuratedPath\(/);
  assert.doesNotMatch(source, /member\.balance\.read\.v1\.json/);
  assert.doesNotMatch(source, /capabilities\/\$\{capabilityId\}/);
});

test('the curated artifact still carries the authored fallback a discovery run cannot reproduce', () => {
  const capability = parseCapability(JSON.parse(readFileSync(CURATED_CAPABILITY_PATH, 'utf8')));
  const target1 = capability.targets['target1'];
  assert.ok(target1, 'curated artifact must declare target1');
  assert.equal(target1.strategies.length, 2);
  assert.equal(target1.strategies[0]?.kind, 'label');
  assert.equal(target1.strategies[1]?.kind, 'nearbyText');
  assert.equal(capability.version, '1.2.0');
});
