import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceWriter, redact } from '../src/evidence.js';
import { buildSafeActionEvent, intentCodeFor } from '../src/discovery.js';

test('redact() scrubs secret-shaped patterns', () => {
  const text = 'used key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and Bearer abc.def-ghi_jkl';
  const output = redact(text);
  assert.doesNotMatch(output, /sk-ant-api03-[A-Za-z0-9_-]{10,}/);
  assert.doesNotMatch(output, /Bearer\s+[A-Za-z0-9._-]+/);
  assert.match(output, /\[REDACTED\]/);
});

test('redact() scrubs declared extraSecrets values', () => {
  const output = redact('the balance is 4231.50 for member 00123', ['4231.50', '00123']);
  assert.doesNotMatch(output, /4231\.50/);
  assert.doesNotMatch(output, /00123/);
});

test('redact() does not touch unrelated env values by mistake (npm_lifecycle_event regression)', () => {
  const originalEvent = process.env.npm_lifecycle_event;
  process.env.npm_lifecycle_event = 'replay';
  try {
    const output = redact('replay_start');
    assert.equal(output, 'replay_start', 'a non-credential-named env var must never be treated as a secret value');
  } finally {
    if (originalEvent === undefined) delete process.env.npm_lifecycle_event;
    else process.env.npm_lifecycle_event = originalEvent;
  }
});

test('buildSafeActionEvent() never carries raw target/rationale text, only structured codes', () => {
  const event = buildSafeActionEvent(3, 'click', { strategyKind: 'role' });
  const serialized = JSON.stringify(event);

  assert.doesNotMatch(serialized, /Ava Thompson/);
  assert.doesNotMatch(serialized, /Savings - S-2001/);
  assert.equal(event.intentCode, 'ACTIVATE_CONTROL');
  assert.deepEqual(Object.keys(event).sort(), ['event', 'intentCode', 'kind', 'strategyKind', 'turn'].sort());
  assert.ok(!('target' in event), 'no raw target field should ever exist on the event');
  assert.ok(!('rationale' in event) && !('reason' in event), 'no free-text rationale field should ever exist on the event');
});

test('EvidenceWriter.trackSensitive() makes record() redact that value from any later event, on disk', () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'computer-use-test-evidence-'));
  const original = process.env.EVIDENCE_DIR;
  process.env.EVIDENCE_DIR = scratchDir;
  try {
    const evidence = createEvidenceWriter('replay');
    assert.deepEqual(evidence.knownSensitiveValues(), []);

    evidence.trackSensitive('4231.50', undefined, '00123');
    assert.deepEqual(evidence.knownSensitiveValues(), ['4231.50', '00123']);

    evidence.record({ event: 'step_start', stepId: 'step-1', intent: 'balance is 4231.50 for member 00123' });

    const written = readFileSync(evidence.filePath, 'utf8');
    assert.doesNotMatch(written, /4231\.50/);
    assert.doesNotMatch(written, /00123/);
    assert.match(written, /\[REDACTED\]/);
  } finally {
    if (original === undefined) delete process.env.EVIDENCE_DIR;
    else process.env.EVIDENCE_DIR = original;
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('intentCodeFor() is a closed, kind-derived vocabulary', () => {
  assert.equal(intentCodeFor('navigate'), 'NAVIGATE');
  assert.equal(intentCodeFor('fill'), 'ENTER_PARAMETER');
  assert.equal(intentCodeFor('click'), 'ACTIVATE_CONTROL');
  assert.equal(intentCodeFor('extract'), 'EXTRACT_VALUE');
  assert.equal(intentCodeFor('done'), 'GOAL_COMPLETE');
  assert.equal(intentCodeFor('stuck'), 'CANNOT_PROCEED');
});
