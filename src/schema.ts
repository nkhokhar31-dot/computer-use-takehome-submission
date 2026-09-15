import { z } from 'zod';


export const ValueRefSchema = z.union([
  z.object({ literal: z.string() }),
  z.object({ inputRef: z.string().min(1) }),
]);
export type ValueRef = z.infer<typeof ValueRefSchema>;

export function resolveValueRef(ref: ValueRef, inputs: Record<string, string>): string {
  if ('literal' in ref) return ref.literal;
  const value = inputs[ref.inputRef];
  if (value === undefined) {
    throw new Error(`Missing input value for inputRef "${ref.inputRef}"`);
  }
  return value;
}


const ProposedNavigate = z.object({
  kind: z.literal('navigate'),
  url: z.string().url(),
  reason: z.string().min(1).optional(),
});
const ProposedFill = z.object({
  kind: z.literal('fill'),
  target: z.string().min(1),
  value: ValueRefSchema,
  reason: z.string().min(1).optional(),
});
const ProposedClick = z.object({
  kind: z.literal('click'),
  target: z.string().min(1),
  reason: z.string().min(1).optional(),
});
const ProposedExtract = z.object({
  kind: z.literal('extract'),
  target: z.string().min(1),
  outputRef: z.string().min(1),
  reason: z.string().min(1).optional(),
});
const ProposedDone = z.object({
  kind: z.literal('done'),
  reason: z.string().min(1).optional(),
});
const ProposedStuck = z.object({
  kind: z.literal('stuck'),
  reason: z.string().min(1),
});

export const ProposedActionSchema = z.discriminatedUnion('kind', [
  ProposedNavigate,
  ProposedFill,
  ProposedClick,
  ProposedExtract,
  ProposedDone,
  ProposedStuck,
]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export function parseProposedAction(input: unknown): ProposedAction {
  const result = ProposedActionSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid action: ${result.error.message}`);
  }
  return result.data;
}


const RoleStrategy = z.object({
  kind: z.literal('role'),
  role: z.string().min(1),
  name: z.string().optional(),
});
const RoleContainsStrategy = z.object({
  kind: z.literal('roleContains'),
  role: z.string().min(1),
  contains: z.string().min(1),
});
const LabelStrategy = z.object({
  kind: z.literal('label'),
  text: z.string().min(1),
});
const NearbyTextStrategy = z.object({
  kind: z.literal('nearbyText'),
  labelText: z.string().min(1),
});

export const LocatorStrategySchema = z.discriminatedUnion('kind', [
  RoleStrategy,
  RoleContainsStrategy,
  LabelStrategy,
  NearbyTextStrategy,
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const TargetSchema = z.object({
  strategies: z.array(LocatorStrategySchema).min(1),
  provenance: z.enum(['authored', 'observed']),
});
export type Target = z.infer<typeof TargetSchema>;


const UrlMatchesCondition = z.object({
  kind: z.literal('urlMatches'),
  pattern: z.string().min(1),
});
const PageContainsTextCondition = z.object({
  kind: z.literal('pageContainsText'),
  text: ValueRefSchema,
});
const FieldValueEqualsCondition = z.object({
  kind: z.literal('fieldValueEquals'),
  targetRef: z.string().min(1),
  value: ValueRefSchema,
});

export const ConditionSchema = z.discriminatedUnion('kind', [
  UrlMatchesCondition,
  PageContainsTextCondition,
  FieldValueEqualsCondition,
]);
export type Condition = z.infer<typeof ConditionSchema>;


const NavigateStepAction = z.object({ kind: z.literal('navigate'), path: z.string().min(1) });
const FillStepAction = z.object({
  kind: z.literal('fill'),
  targetRef: z.string().min(1),
  value: ValueRefSchema,
});
const ClickStepAction = z.object({ kind: z.literal('click'), targetRef: z.string().min(1) });
const ExtractStepAction = z.object({
  kind: z.literal('extract'),
  targetRef: z.string().min(1),
  outputRef: z.string().min(1),
});

export const StepActionSchema = z.discriminatedUnion('kind', [
  NavigateStepAction,
  FillStepAction,
  ClickStepAction,
  ExtractStepAction,
]);
export type StepAction = z.infer<typeof StepActionSchema>;

export const StepSchema = z.object({
  id: z.string().min(1),
  intent: z.string().min(1),
  action: StepActionSchema,
  preconditionRef: z.string().optional(),
  postconditionRef: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  zeroMatchOutcome: z.object({ code: z.string().min(1) }).optional(),
  postconditionRecovery: z
    .object({ maxAttempts: z.number().int().positive(), delayMs: z.number().int().nonnegative() })
    .optional(),
});
export type Step = z.infer<typeof StepSchema>;


export const BlockerSchema = z.object({
  signatureRef: z.string().min(1),
  classification: z.enum(['intervention', 'PERMISSION_DENIED', 'APPLICATION_ERROR', 'SESSION_LOST']),
  reasonCode: z.string().min(1),
});
export type Blocker = z.infer<typeof BlockerSchema>;


const IoFieldSchema = z.object({
  type: z.literal('string'),
  sensitivity: z.enum(['public', 'sensitive']),
  description: z.string().min(1),
});
export type IoField = z.infer<typeof IoFieldSchema>;

export const CapabilitySchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  id: z.string().min(1),
  version: z.string().min(1),
  profileId: z.string().min(1),
  goal: z.string().min(1),
  inputs: z.record(z.string(), IoFieldSchema),
  outputs: z.record(z.string(), IoFieldSchema),
  targets: z.record(z.string(), TargetSchema),
  conditions: z.record(z.string(), ConditionSchema),
  steps: z.array(StepSchema).min(1),
  blockers: z.array(BlockerSchema).default([]),
  discoveryProvenance: z.object({
    mode: z.enum(['authored', 'observed']),
    note: z.string().min(1),
    discoveredAt: z.string().optional(),
    model: z.string().optional(),
    runId: z.string().optional(),
  }),
});
export type Capability = z.infer<typeof CapabilitySchema>;

export function parseCapability(input: unknown): Capability {
  const result = CapabilitySchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid capability artifact: ${result.error.message}`);
  }
  return result.data;
}


export const FailureCategorySchema = z.enum([
  'INVALID_INPUT',
  'INVALID_ARTIFACT',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'PRECONDITION_FAILED',
  'POSTCONDITION_FAILED',
  'TIMEOUT',
  'POLICY_BLOCKED',
  'PERMISSION_DENIED',
  'APPLICATION_ERROR',
  'SESSION_LOST',
  'DRIVER_ERROR',
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export interface InterventionPayload {
  interventionId: string;
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  goal: string;
  stepId: string;
  stepIntent: string;
  reasonCode: string;
  reason: string;
  lastVerifiedCheckpoint?: string;
  currentScreen: string;
  screenshotRef: string;
  sessionId: string;
  controlEpoch: number;
  requiredAction: string;
  createdAt: string;
}

export type ReplayResult =
  | { type: 'success'; outputs: Record<string, string> }
  | { type: 'business_outcome'; code: string; step: string }
  | {
      type: 'failure';
      step: string;
      category: FailureCategory;
      expected: string;
      observed: string;
      effect: 'none' | 'confirmed' | 'unknown';
    }
  | ({ type: 'intervention_required' } & InterventionPayload)
  | { type: 'aborted'; step: string; interventionId: string; reason: string };
