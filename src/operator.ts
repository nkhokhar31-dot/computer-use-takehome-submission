import { createInterface } from 'node:readline';
import { startHumanActivityCapture, type RawHumanActivity } from './browser.js';
import type { EvidenceWriter } from './evidence.js';
import type { Profile } from './profile.js';
import type { DispatchGuard } from './runtime.js';

export type OperatorDecision = 'resume' | 'abort' | 'input_closed';

export type OperatorPrompt = () => Promise<OperatorDecision>;

export function abortReasonFor(decision: OperatorDecision): string | null {
  if (decision === 'abort') return 'operator aborted';
  if (decision === 'input_closed') return 'operator input closed before a decision';
  return null;
}

type OperatorInput = NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };

export async function promptResumeOrAbort(
  input: OperatorInput = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<OperatorDecision> {
  if (input.readableEnded || input.destroyed) return 'input_closed';

  const rl = createInterface({ input, output });
  const echoesInput = (input as { isTTY?: boolean }).isTTY === true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision: OperatorDecision) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(decision);
    };
    rl.on('line', (line) => {
      if (!echoesInput) output.write('\n');
      const answer = line.trim().toLowerCase();
      if (answer === 'resume' || answer === 'abort') return finish(answer);
      output.write(`Unrecognized input "${answer}" - please type exactly "resume" or "abort".\n`);
      rl.prompt();
    });
    rl.on('close', () => {
      if (!settled) output.write('\n');
      finish('input_closed');
    });
    rl.setPrompt('Type "resume" once the browser is fixed, or "abort" to cancel: ');
    rl.prompt();
  });
}


export type HumanElementKind =
  | 'link'
  | 'button'
  | 'text_input'
  | 'password_input'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'textarea'
  | 'form'
  | 'other';

export interface SanitizedHumanAction {
  kind: 'click' | 'change' | 'submit' | 'key' | 'navigation' | 'new_window';
  element?: HumanElementKind;
  key?: 'Enter' | 'Escape' | 'Tab';
  route?: string;
}

const ELEMENT_BY_ROLE = new Map<string, HumanElementKind>([
  ['link', 'link'],
  ['button', 'button'],
  ['textbox', 'text_input'],
  ['searchbox', 'text_input'],
  ['checkbox', 'checkbox'],
  ['radio', 'radio'],
  ['combobox', 'select'],
  ['listbox', 'select'],
]);
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'date']);
const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'image', 'reset']);

function elementKind(raw: RawHumanActivity): HumanElementKind {
  const byRole = typeof raw.role === 'string' ? ELEMENT_BY_ROLE.get(raw.role.toLowerCase()) : undefined;
  if (byRole) return byRole;
  switch (raw.tag) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'select':
      return 'select';
    case 'textarea':
      return 'textarea';
    case 'form':
      return 'form';
    case 'input': {
      const type = typeof raw.inputType === 'string' ? raw.inputType : '';
      if (type === 'password') return 'password_input';
      if (type === 'checkbox' || type === 'radio') return type;
      if (BUTTON_INPUT_TYPES.has(type)) return 'button';
      return TEXT_INPUT_TYPES.has(type) ? 'text_input' : 'other';
    }
    default:
      return 'other';
  }
}

export function routeLabel(url: string, profile: Profile): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'NON_HTTP';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'NON_HTTP';
  if (parsed.origin !== new URL(profile.allowedOrigin).origin) return 'OTHER_ORIGIN';
  return profile.allowedRoutePatterns.find((pattern) => pattern.test(parsed.pathname))?.source ?? 'ROUTE_NOT_ALLOWED';
}

export function sanitizeHumanActivity(raw: RawHumanActivity, profile: Profile): SanitizedHumanAction | null {
  switch (raw.type) {
    case 'click':
      return { kind: 'click', element: elementKind(raw) };
    case 'change':
      return { kind: 'change', element: elementKind(raw) };
    case 'submit':
      return { kind: 'submit', element: 'form' };
    case 'key':
      return raw.key === 'Enter' || raw.key === 'Escape' || raw.key === 'Tab'
        ? { kind: 'key', key: raw.key, element: elementKind(raw) }
        : null;
    case 'navigation':
      return typeof raw.url === 'string' ? { kind: 'navigation', route: routeLabel(raw.url, profile) } : null;
    case 'popup':
      return { kind: 'new_window' };
    default:
      return null;
  }
}

export interface TakeoverSummary {
  humanActionCount: number;
  policyBlockedCount: number;
}

export async function startTakeoverRecording(params: {
  guard: DispatchGuard;
  evidence: EvidenceWriter;
  profile: Profile;
  interventionId: string;
}): Promise<{ stop(): TakeoverSummary }> {
  const { guard, evidence, profile, interventionId } = params;
  const controlEpoch = guard.session.controlEpoch;
  const humanHoldsThisEpoch = () => guard.session.owner === 'human' && guard.session.controlEpoch === controlEpoch;
  let seq = 0;
  const summary: TakeoverSummary = { humanActionCount: 0, policyBlockedCount: 0 };

  let detachCapture = () => {};
  try {
    detachCapture = await startHumanActivityCapture(guard.page, (raw) => {
      if (!humanHoldsThisEpoch()) return;
      const action = sanitizeHumanActivity(raw, profile);
      if (!action) return;
      summary.humanActionCount++;
      evidence.record({ event: 'human_action', interventionId, controlEpoch, seq: ++seq, ...action });
    });
  } catch {
    evidence.record({ event: 'takeover_recording_unavailable', interventionId, controlEpoch });
  }

  const unsubscribe = guard.policy?.subscribe((violation) => {
    if (violation.owner !== 'human' || !humanHoldsThisEpoch()) return;
    summary.policyBlockedCount++;
    evidence.record({ event: 'policy_blocked', interventionId, controlEpoch, seq: ++seq, ...violation });
  });

  return {
    stop() {
      detachCapture();
      unsubscribe?.();
      return { ...summary };
    },
  };
}
