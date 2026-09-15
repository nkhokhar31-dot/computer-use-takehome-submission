import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { captureMaskedScreenshot, evaluateCondition, resolveTarget } from './browser.js';
import {
  DispatchGuard,
  PolicyViolationError,
  attachNetworkPolicy,
  guardedClick,
  guardedExtract,
  guardedFill,
  guardedNavigateRelative,
  guardedReload,
} from './runtime.js';
import { abortReasonFor, promptResumeOrAbort, startTakeoverRecording, type OperatorPrompt } from './operator.js';
import type { Profile } from './profile.js';
import type { Blocker, Capability, FailureCategory, InterventionPayload, ReplayResult, Step, Target } from './schema.js';
import { resolveValueRef } from './schema.js';
import { redact, type EvidenceWriter } from './evidence.js';

export interface ReplayOptions {
  operatorPrompt?: OperatorPrompt;
}

type Effect = 'none' | 'confirmed' | 'unknown';

class TimeoutMarker extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeScreenSummary(page: Page, sensitiveValues: string[]): string {
  return redact(page.url(), sensitiveValues);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutMarker(`exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

const CLOSED_TARGET_MESSAGE = /Target page, context or browser has been closed|Target closed|Browser has been closed|browser has disconnected/i;

function isSessionLoss(error: unknown, page: Page): boolean {
  return page.isClosed() || (error instanceof Error && CLOSED_TARGET_MESSAGE.test(error.message));
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
}

function sessionLost(stepId: string, effect: Effect): ReplayResult {
  return {
    type: 'failure',
    step: stepId,
    category: 'SESSION_LOST',
    expected: 'browser session alive',
    observed: 'browser page, context or process closed',
    effect,
  };
}

function toFailure(stepId: string, error: unknown, effect: Effect, page: Page, sensitiveValues: string[]): ReplayResult {
  const observed = redact(firstLine(error), sensitiveValues);
  if (error instanceof PolicyViolationError) {
    const effectForPolicy = error.phase === 'pre-dispatch' ? 'none' : error.phase === 'network' ? 'unknown' : 'confirmed';
    return { type: 'failure', step: stepId, category: 'POLICY_BLOCKED', expected: 'action to complete', observed, effect: effectForPolicy };
  }
  if (isSessionLoss(error, page)) return sessionLost(stepId, effect);
  const category: FailureCategory = error instanceof TimeoutMarker ? 'TIMEOUT' : 'DRIVER_ERROR';
  return { type: 'failure', step: stepId, category, expected: 'action to complete', observed, effect };
}

export function validateInputs(capability: Capability, inputs: Record<string, unknown>): ReplayResult | null {
  for (const [name] of Object.entries(capability.inputs)) {
    if (!(name in inputs)) {
      return {
        type: 'failure',
        step: '(pre-flight)',
        category: 'INVALID_INPUT',
        expected: `input "${name}" present`,
        observed: 'missing',
        effect: 'none',
      };
    }
    if (typeof inputs[name] !== 'string') {
      return {
        type: 'failure',
        step: '(pre-flight)',
        category: 'INVALID_INPUT',
        expected: `input "${name}" is a string`,
        observed: typeof inputs[name],
        effect: 'none',
      };
    }
  }
  return null;
}

type StepExecOutcome = { type: 'ok' } | { type: 'stop'; result: ReplayResult };

function dispatchedEffect(step: Step): Effect {
  return step.action.kind === 'click' ? 'unknown' : 'none';
}

async function executeStepAction(
  page: Page,
  step: Step,
  targets: Record<string, Target>,
  inputs: Record<string, string>,
  outputs: Record<string, string>,
  guard: DispatchGuard,
  profile: Profile,
  sensitiveValues: string[],
): Promise<StepExecOutcome> {
  const action = step.action;

  if (action.kind === 'navigate') {
    try {
      await withTimeout(guardedNavigateRelative(guard, guard.session.controlEpoch, page, action.path, profile), step.timeoutMs);
    } catch (error) {
      return { type: 'stop', result: toFailure(step.id, error, 'none', page, sensitiveValues) };
    }
    return page.isClosed() ? { type: 'stop', result: sessionLost(step.id, 'none') } : { type: 'ok' };
  }

  const target = targets[action.targetRef];
  if (!target) {
    return {
      type: 'stop',
      result: {
        type: 'failure',
        step: step.id,
        category: 'INVALID_ARTIFACT',
        expected: `known targetRef "${action.targetRef}"`,
        observed: 'undefined',
        effect: 'none',
      },
    };
  }

  const resolution = await resolveTarget(page, target);

  if (resolution.outcome === 'zero') {
    if (step.zeroMatchOutcome) {
      return {
        type: 'stop',
        result: { type: 'business_outcome', code: step.zeroMatchOutcome.code, step: step.id },
      };
    }
    return {
      type: 'stop',
      result: {
        type: 'failure',
        step: step.id,
        category: 'TARGET_NOT_FOUND',
        expected: 'exactly one match',
        observed: '0 matches',
        effect: 'none',
      },
    };
  }
  if (resolution.outcome === 'ambiguous') {
    return {
      type: 'stop',
      result: {
        type: 'failure',
        step: step.id,
        category: 'TARGET_AMBIGUOUS',
        expected: 'exactly one match',
        observed: `${resolution.count} matches`,
        effect: 'none',
      },
    };
  }

  try {
    if (action.kind === 'fill') {
      const value = resolveValueRef(action.value, inputs);
      await withTimeout(guardedFill(guard, guard.session.controlEpoch, resolution.locator, value), step.timeoutMs);
    } else if (action.kind === 'click') {
      await withTimeout(guardedClick(guard, guard.session.controlEpoch, resolution.locator, profile), step.timeoutMs);
    } else if (action.kind === 'extract') {
      const value = await withTimeout(guardedExtract(guard, guard.session.controlEpoch, resolution.locator), step.timeoutMs);
      outputs[action.outputRef] = value;
    }
  } catch (error) {
    return { type: 'stop', result: toFailure(step.id, error, dispatchedEffect(step), page, sensitiveValues) };
  }

  if (page.isClosed()) {
    return { type: 'stop', result: sessionLost(step.id, dispatchedEffect(step)) };
  }

  return { type: 'ok' };
}

async function classifyBlockers(
  page: Page,
  capability: Capability,
  inputs: Record<string, string>,
): Promise<Blocker | null> {
  for (const blocker of capability.blockers) {
    const condition = capability.conditions[blocker.signatureRef];
    if (!condition) continue;
    const check = await evaluateCondition(page, condition, capability.targets, inputs);
    if (check.passed) return blocker;
  }
  return null;
}

export interface ResumeValidation {
  ok: boolean;
  reasonCode?: 'SESSION_LOST';
  stillBlocked?: boolean;
  checkpointOk?: boolean;
  error?: string;
}

export async function verifyResumeState(
  page: Page,
  capability: Capability,
  inputs: Record<string, string>,
  blocker: Blocker,
  checkpointRef: string | undefined,
): Promise<ResumeValidation> {
  if (page.isClosed()) {
    return { ok: false, reasonCode: 'SESSION_LOST' };
  }

  try {
    const signature = capability.conditions[blocker.signatureRef];
    const stillBlocked = signature
      ? (await evaluateCondition(page, signature, capability.targets, inputs)).passed
      : false;

    let checkpointOk = true;
    if (checkpointRef) {
      const checkpointCondition = capability.conditions[checkpointRef];
      if (checkpointCondition) {
        checkpointOk = (await evaluateCondition(page, checkpointCondition, capability.targets, inputs)).passed;
      }
    }

    return { ok: !stillBlocked && checkpointOk, stillBlocked, checkpointOk };
  } catch (error) {
    return { ok: false, reasonCode: 'SESSION_LOST', error: firstLine(error) };
  }
}

type BlockerOutcome = { type: 'resumed' } | { type: 'stop'; result: ReplayResult };

async function handleBlocker(
  blocker: Blocker,
  step: Step,
  capability: Capability,
  inputs: Record<string, string>,
  outputs: Record<string, string>,
  page: Page,
  guard: DispatchGuard,
  evidence: EvidenceWriter,
  profile: Profile,
  operatorPrompt: OperatorPrompt = promptResumeOrAbort,
): Promise<BlockerOutcome> {
  const screenshotBuffer = await captureMaskedScreenshot(page, capability, inputs, outputs).catch(() => null);
  const screenshotRef = evidence.saveScreenshot(screenshotBuffer, step.id);

  if (blocker.classification !== 'intervention') {
    evidence.record({
      event: 'blocker',
      stepId: step.id,
      classification: blocker.classification,
      reasonCode: blocker.reasonCode,
      screenshotRef,
    });
    return {
      type: 'stop',
      result: {
        type: 'failure',
        step: step.id,
        category: blocker.classification,
        expected: 'no known blocker',
        observed: blocker.reasonCode,
        effect: 'confirmed',
      },
    };
  }

  const interventionId = `intervention-${randomUUID().slice(0, 8)}`;
  const checkpointRef = step.postconditionRef;

  for (;;) {
    const epoch = await guard.pauseAndTransferToHuman();
    const recording = await startTakeoverRecording({ guard, evidence, profile, interventionId });

    const payload: InterventionPayload = {
      interventionId,
      runId: evidence.runId,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      goal: capability.goal,
      stepId: step.id,
      stepIntent: step.intent,
      reasonCode: blocker.reasonCode,
      reason: `A known blocker ("${blocker.reasonCode}") was detected instead of the expected screen.`,
      lastVerifiedCheckpoint: guard.session.lastVerifiedCheckpoint,
      currentScreen: safeScreenSummary(page, evidence.knownSensitiveValues()),
      screenshotRef,
      sessionId: guard.session.sessionId,
      controlEpoch: epoch,
      requiredAction: 'Operate the browser to resolve this, then type "resume" (or "abort" to cancel).',
      createdAt: new Date().toISOString(),
    };
    evidence.record({ event: 'intervention_required', ...payload });
    console.log(`\n${JSON.stringify(payload, null, 2)}\n`);
    console.log('A human must now operate the browser window this process opened.');

    const answer = await operatorPrompt();
    const abortReason = abortReasonFor(answer);

    if (abortReason) {
      const summary = recording.stop();
      guard.abort();
      evidence.record({ event: 'aborted', stepId: step.id, interventionId, reason: abortReason, ...summary });
      return { type: 'stop', result: { type: 'aborted', step: step.id, interventionId, reason: abortReason } };
    }

    const validation = await verifyResumeState(page, capability, inputs, blocker, checkpointRef);

    if (!validation.ok) {
      const summary = recording.stop();
      evidence.record({ event: 'resume_rejected', stepId: step.id, ...validation, ...summary });
      if (validation.reasonCode === 'SESSION_LOST') {
        return { type: 'stop', result: sessionLost(step.id, 'unknown') };
      }
      console.log(
        `Resume rejected: ${validation.stillBlocked ? 'the blocker is still present' : `checkpoint "${checkpointRef}" is not satisfied`}. The run stays paused.`,
      );
      continue;
    }

    const summary = recording.stop();
    guard.handBackToAutomation();
    evidence.record({ event: 'handback', stepId: step.id, controlEpoch: guard.session.controlEpoch, ...summary });
    return { type: 'resumed' };
  }
}

interface StepProgress {
  stepId: string;
  effect: Effect;
}

export async function replay(
  capability: Capability,
  inputs: Record<string, string>,
  profile: Profile,
  page: Page,
  guard: DispatchGuard,
  evidence: EvidenceWriter,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const inputError = validateInputs(capability, inputs);
  if (inputError) return inputError;

  const progress: StepProgress = { stepId: '(pre-flight)', effect: 'none' };
  let unsubscribePolicy: (() => void) | undefined;

  try {
    await attachNetworkPolicy(guard, profile);
    unsubscribePolicy = guard.policy!.subscribe((violation) => {
      if (violation.owner === 'automation') evidence.record({ event: 'policy_blocked', ...violation });
    });

    return await runSteps(capability, inputs, profile, page, guard, evidence, options, progress);
  } catch (error) {
    const result = toFailure(progress.stepId, error, progress.effect, page, evidence.knownSensitiveValues());
    evidence.record({ event: 'step_result', stepId: progress.stepId, outcome: result.type });
    return result;
  } finally {
    unsubscribePolicy?.();
  }
}

async function runSteps(
  capability: Capability,
  inputs: Record<string, string>,
  profile: Profile,
  page: Page,
  guard: DispatchGuard,
  evidence: EvidenceWriter,
  options: ReplayOptions,
  progress: StepProgress,
): Promise<ReplayResult> {
  for (const [name, value] of Object.entries(inputs)) {
    if (capability.inputs[name]?.sensitivity === 'sensitive') evidence.trackSensitive(value);
  }

  evidence.record({
    event: 'replay_start',
    capabilityId: capability.id,
    version: capability.version,
    inputNames: Object.keys(inputs),
  });

  const outputs: Record<string, string> = {};
  let stepIndex = 0;

  while (stepIndex < capability.steps.length) {
    const step = capability.steps[stepIndex]!;
    progress.stepId = step.id;
    progress.effect = 'none';
    evidence.record({ event: 'step_start', stepId: step.id, intent: step.intent });

    if (step.preconditionRef) {
      const condition = capability.conditions[step.preconditionRef];
      if (!condition) {
        evidence.record({ event: 'step_result', stepId: step.id, outcome: 'invalid_artifact' });
        return {
          type: 'failure',
          step: step.id,
          category: 'INVALID_ARTIFACT',
          expected: `known preconditionRef "${step.preconditionRef}"`,
          observed: 'undefined',
          effect: 'none',
        };
      }
      const check = await evaluateCondition(page, condition, capability.targets, inputs);
      if (!check.passed) {
        evidence.record({ event: 'step_result', stepId: step.id, outcome: 'precondition_failed' });
        return {
          type: 'failure',
          step: step.id,
          category: 'PRECONDITION_FAILED',
          expected: check.expected,
          observed: check.observed,
          effect: 'none',
        };
      }
    }

    const outcome = await executeStepAction(
      page,
      step,
      capability.targets,
      inputs,
      outputs,
      guard,
      profile,
      evidence.knownSensitiveValues(),
    );
    if (outcome.type === 'stop') {
      evidence.record({ event: 'step_result', stepId: step.id, outcome: outcome.result.type });
      return outcome.result;
    }
    progress.effect = dispatchedEffect(step);

    if (step.action.kind === 'extract' && capability.outputs[step.action.outputRef]?.sensitivity === 'sensitive') {
      evidence.trackSensitive(outputs[step.action.outputRef]);
    }

    const blocker = await classifyBlockers(page, capability, inputs);
    if (blocker) {
      const handled = await handleBlocker(blocker, step, capability, inputs, outputs, page, guard, evidence, profile, options.operatorPrompt);
      if (handled.type === 'resumed') {
        evidence.record({ event: 'step_result', stepId: step.id, outcome: 'success_after_intervention' });
        if (step.postconditionRef) guard.session.lastVerifiedCheckpoint = step.postconditionRef;
        stepIndex++;
        continue;
      }
      evidence.record({ event: 'step_result', stepId: step.id, outcome: handled.result.type });
      return handled.result;
    }

    if (step.postconditionRef) {
      const condition = capability.conditions[step.postconditionRef];
      if (!condition) {
        evidence.record({ event: 'step_result', stepId: step.id, outcome: 'invalid_artifact' });
        return {
          type: 'failure',
          step: step.id,
          category: 'INVALID_ARTIFACT',
          expected: `known postconditionRef "${step.postconditionRef}"`,
          observed: 'undefined',
          effect: 'none',
        };
      }

      let check = await evaluateCondition(page, condition, capability.targets, inputs);
      let attempt = 0;
      const recovery = step.postconditionRecovery;
      while (!check.passed && recovery && attempt < recovery.maxAttempts) {
        attempt++;
        evidence.record({ event: 'recovery_attempt', stepId: step.id, attempt, maxAttempts: recovery.maxAttempts });
        await sleep(recovery.delayMs);
        try {
          await guardedReload(guard, guard.session.controlEpoch, page);
        } catch (error) {
          return toFailure(step.id, error, progress.effect, page, evidence.knownSensitiveValues());
        }
        check = await evaluateCondition(page, condition, capability.targets, inputs);
      }

      if (!check.passed) {
        evidence.record({ event: 'step_result', stepId: step.id, outcome: 'postcondition_failed', recoveryAttempts: attempt });
        return {
          type: 'failure',
          step: step.id,
          category: 'POSTCONDITION_FAILED',
          expected: check.expected,
          observed: check.observed,
          effect: dispatchedEffect(step),
        };
      }
      if (attempt > 0) {
        evidence.record({ event: 'recovery_succeeded', stepId: step.id, attempts: attempt });
      }
      guard.session.lastVerifiedCheckpoint = step.postconditionRef;
    }

    evidence.record({ event: 'step_result', stepId: step.id, outcome: 'success' });
    stepIndex++;
  }

  const missingOutputs = Object.keys(capability.outputs).filter((name) => !(name in outputs));
  if (missingOutputs.length > 0) {
    evidence.record({ event: 'replay_result', outcome: 'invalid_artifact' });
    return {
      type: 'failure',
      step: '(final)',
      category: 'INVALID_ARTIFACT',
      expected: `outputs produced for: ${missingOutputs.join(', ')}`,
      observed: 'not produced by any step',
      effect: 'none',
    };
  }

  evidence.record({ event: 'replay_result', outcome: 'success', outputKeys: Object.keys(outputs) });
  return { type: 'success', outputs };
}
