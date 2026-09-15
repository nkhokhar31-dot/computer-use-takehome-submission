import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscoveryInterventionPayload } from '../src/discovery.js';

test('buildDiscoveryInterventionPayload redacts the reason and current screen against sensitive values', () => {
  const payload = buildDiscoveryInterventionPayload({
    interventionId: 'intervention-abc',
    runId: 'run-1',
    goal: 'Look up the requested member and read their savings balance',
    turn: 4,
    reasonCode: 'AGENT_STUCK',
    reason: 'Cannot find a link for member 00123 (balance 4231.50) anywhere on this screen',
    currentScreenRaw: 'http://localhost:3000/member/00123',
    screenshotRef: 'evidence/escalation/run-1-discovery-turn-4.masked.png',
    sessionId: 'session-1',
    controlEpoch: 2,
    sensitiveValues: ['00123', '4231.50'],
  });

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /00123/);
  assert.doesNotMatch(serialized, /4231\.50/);
  assert.match(payload.reason, /\[REDACTED\]/);
  assert.match(payload.currentScreen, /\[REDACTED\]/);
});

test('buildDiscoveryInterventionPayload carries the reason code and identifiers through untouched', () => {
  const payload = buildDiscoveryInterventionPayload({
    interventionId: 'intervention-xyz',
    runId: 'run-2',
    goal: 'test goal',
    turn: 7,
    reasonCode: 'DEAD_END',
    reason: 'Repeated the same ACTIVATE_CONTROL action on an unchanged screen 3 times.',
    currentScreenRaw: 'http://localhost:3000/search',
    screenshotRef: 'suppressed',
    sessionId: 'session-2',
    controlEpoch: 1,
    sensitiveValues: [],
  });

  assert.equal(payload.interventionId, 'intervention-xyz');
  assert.equal(payload.runId, 'run-2');
  assert.equal(payload.reasonCode, 'DEAD_END');
  assert.equal(payload.turn, 7);
  assert.equal(payload.controlEpoch, 1);
  assert.equal(payload.screenshotRef, 'suppressed');
  assert.equal(payload.currentScreen, 'http://localhost:3000/search');
  assert.match(payload.requiredAction, /resume/);
});

test('buildDiscoveryInterventionPayload leaves non-matching text alone (no over-redaction)', () => {
  const payload = buildDiscoveryInterventionPayload({
    interventionId: 'i',
    runId: 'r',
    goal: 'g',
    turn: 1,
    reasonCode: 'AGENT_STUCK',
    reason: 'The model could not locate the expected control.',
    currentScreenRaw: 'http://localhost:3000/',
    screenshotRef: 'suppressed',
    sessionId: 's',
    controlEpoch: 0,
    sensitiveValues: ['00999'],
  });

  assert.equal(payload.reason, 'The model could not locate the expected control.');
  assert.equal(payload.currentScreen, 'http://localhost:3000/');
});
