import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInputsFile, readJsonFile } from '../src/cli.js';

let scratchDir: string;

test('loadInputsFile: a missing --input file is a structured INVALID_INPUT failure, not a raw ENOENT', () => {
  const result = loadInputsFile('/definitely/does/not/exist/input.json');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.result.type, 'failure');
    if (result.result.type === 'failure') {
      assert.equal(result.result.category, 'INVALID_INPUT');
      assert.equal(result.result.step, '(pre-flight)');
      assert.match(result.result.observed, /Could not read/);
    }
  }
});

test('loadInputsFile: a malformed (non-JSON) --input file is a structured INVALID_INPUT failure', () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'computer-use-cli-input-'));
  try {
    const path = join(scratchDir, 'bad.json');
    writeFileSync(path, '{ not valid json');
    const result = loadInputsFile(path);
    assert.equal(result.ok, false);
    if (!result.ok && result.result.type === 'failure') {
      assert.equal(result.result.category, 'INVALID_INPUT');
      assert.match(result.result.observed, /not valid JSON/);
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('loadInputsFile: a well-formed JSON object file loads normally', () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'computer-use-cli-input-'));
  try {
    const path = join(scratchDir, 'good.json');
    writeFileSync(path, JSON.stringify({ memberId: '00123' }));
    const result = loadInputsFile(path);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.data, { memberId: '00123' });
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('loadInputsFile: a JSON array file is treated as no inputs, not as a crash', () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'computer-use-cli-input-'));
  try {
    const path = join(scratchDir, 'array.json');
    writeFileSync(path, '[1,2,3]');
    const result = loadInputsFile(path);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.data, {});
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('readJsonFile: error messages name the offending path for both an unreadable and an invalid file', () => {
  assert.throws(() => readJsonFile('/definitely/does/not/exist/input.json'), /Could not read "\/definitely\/does\/not\/exist\/input\.json"/);

  scratchDir = mkdtempSync(join(tmpdir(), 'computer-use-cli-input-'));
  try {
    const path = join(scratchDir, 'bad.json');
    writeFileSync(path, 'not json at all');
    assert.throws(() => readJsonFile(path), /is not valid JSON/);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
