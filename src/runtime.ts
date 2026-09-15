import type { Page, Locator } from 'playwright';
import {
  performNavigate,
  performFill,
  performClick,
  performExtract,
  performReload,
  describeClickTarget,
  installRequestGate,
  type ClickTargetFacts,
  type GateRequestInfo,
} from './browser.js';
import type { Profile } from './profile.js';

export type PolicyPhase = 'pre-dispatch' | 'network';

export class PolicyViolationError extends Error {
  readonly code?: string;
  readonly phase?: PolicyPhase;
  constructor(message: string, meta?: { code?: string; phase?: PolicyPhase }) {
    super(message);
    this.code = meta?.code;
    this.phase = meta?.phase;
  }
}
export class OwnershipError extends Error {}
export class StaleActionError extends Error {}
export class PageContextError extends Error {}

export function assertOriginAllowed(url: string, profile: Profile): void {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new PolicyViolationError(`Refusing navigation to unparsable URL: ${url}`);
  }
  const allowed = new URL(profile.allowedOrigin);
  if (target.origin !== allowed.origin) {
    throw new PolicyViolationError(`Refusing navigation outside allowed origin ${allowed.origin}: ${url}`);
  }
  const routeAllowed = profile.allowedRoutePatterns.some((pattern) => pattern.test(target.pathname));
  if (!routeAllowed) {
    throw new PolicyViolationError(`Refusing navigation to disallowed route: ${target.pathname}`);
  }
}

export type Owner = 'automation' | 'human';
export type Lifecycle = 'running' | 'paused' | 'completed' | 'aborted';

export interface SessionState {
  sessionId: string;
  owner: Owner;
  controlEpoch: number;
  lifecycle: Lifecycle;
  lastVerifiedCheckpoint?: string;
}

export class DispatchGuard {
  readonly session: SessionState;
  readonly page: Page;
  policy?: NetworkPolicy;
  private queue: Promise<unknown> = Promise.resolve();
  private transferring = false;

  constructor(sessionId: string, page: Page) {
    this.session = { sessionId, owner: 'automation', controlEpoch: 0, lifecycle: 'running' };
    this.page = page;
  }

  private assertAutomationMayDispatch(epoch: number, context: Page): void {
    if (this.transferring || this.session.owner !== 'automation') {
      throw new OwnershipError('Automated dispatch refused: control is not with automation.');
    }
    if (epoch !== this.session.controlEpoch) {
      throw new StaleActionError(`Stale action for epoch ${epoch}; current epoch is ${this.session.controlEpoch}.`);
    }
    if (context !== this.page) {
      throw new PageContextError(
        'Automated dispatch refused: action targets a different page than this guard is bound to.',
      );
    }
  }

  run<T>(epoch: number, context: Page, fn: () => Promise<T>): Promise<T> {
    try {
      this.assertAutomationMayDispatch(epoch, context);
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async pauseAndTransferToHuman(): Promise<number> {
    this.transferring = true;
    await this.queue;
    this.session.owner = 'human';
    this.session.lifecycle = 'paused';
    this.session.controlEpoch += 1;
    this.transferring = false;
    return this.session.controlEpoch;
  }

  handBackToAutomation(): number {
    this.session.owner = 'automation';
    this.session.lifecycle = 'running';
    this.session.controlEpoch += 1;
    return this.session.controlEpoch;
  }

  abort(): void {
    this.session.lifecycle = 'aborted';
  }
}


export interface PolicyViolation {
  code: string;
  phase: PolicyPhase;
  owner: Owner;
  navigation?: boolean;
  redirect?: boolean;
  matchedTerm?: string;
}

export interface NetworkPolicy {
  subscribe(listener: (violation: PolicyViolation) => void): () => void;
  emit(violation: PolicyViolation): void;
  settle(page: Page, timeoutMs?: number): Promise<void>;
}

export async function attachNetworkPolicy(guard: DispatchGuard, profile: Profile): Promise<NetworkPolicy> {
  if (guard.policy) return guard.policy;

  const subscribers = new Set<(violation: PolicyViolation) => void>();
  const emit = (violation: PolicyViolation) => {
    for (const listener of subscribers) listener(violation);
  };

  const allowed = new URL(profile.allowedOrigin);

  const gate = await installRequestGate(guard.page.context(), {
    decide(info: GateRequestInfo): string | null {
      let target: URL;
      try {
        target = new URL(info.url);
      } catch {
        return 'ORIGIN_NOT_ALLOWED';
      }
      if (target.origin !== allowed.origin) return 'ORIGIN_NOT_ALLOWED';
      if (info.navigation) {
        const routeOk = profile.allowedRoutePatterns.some((pattern) => pattern.test(target.pathname));
        if (!routeOk) return 'ROUTE_NOT_ALLOWED';
      }
      if (info.method !== 'GET' && info.method !== 'HEAD') return 'UNSAFE_METHOD';
      return null;
    },
    onBlocked(info, code) {
      emit({ code, phase: 'network', owner: guard.session.owner, navigation: info.navigation, redirect: info.redirect });
    },
    onNewWindow(popup) {
      popup.close().catch(() => {});
      emit({ code: 'POPUP_NOT_SUPPORTED', phase: 'network', owner: guard.session.owner });
    },
    onWebSocketBlocked() {
      emit({ code: 'UNSAFE_METHOD', phase: 'network', owner: guard.session.owner });
    },
  });

  const policy: NetworkPolicy = {
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    emit,
    settle: (page, timeoutMs) => gate.settle(page, timeoutMs),
  };
  guard.policy = policy;
  return policy;
}


export interface ClickPolicyViolation {
  code: 'RISKY_CONTROL' | 'UNSAFE_METHOD' | 'ORIGIN_NOT_ALLOWED' | 'ROUTE_NOT_ALLOWED' | 'POPUP_NOT_SUPPORTED';
  matchedTerm?: string;
}

const RISKY_TERMS = new Set([
  'delete', 'remove', 'close', 'cancel', 'confirm', 'transfer', 'wire',
  'withdraw', 'deactivate', 'terminate',
]);

function classifyDestination(url: string, profile: Profile): ClickPolicyViolation | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { code: 'ORIGIN_NOT_ALLOWED' };
  }
  const allowed = new URL(profile.allowedOrigin);
  if (target.origin !== allowed.origin) return { code: 'ORIGIN_NOT_ALLOWED' };
  const routeOk = profile.allowedRoutePatterns.some((pattern) => pattern.test(target.pathname));
  return routeOk ? null : { code: 'ROUTE_NOT_ALLOWED' };
}

export function classifyClick(facts: ClickTargetFacts, profile?: Profile): ClickPolicyViolation | null {
  const words = facts.label.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    if (RISKY_TERMS.has(word)) return { code: 'RISKY_CONTROL', matchedTerm: word };
  }

  if (facts.submitsForm && facts.formMethod && facts.formMethod !== 'get') {
    return { code: 'UNSAFE_METHOD' };
  }

  if (facts.opensNewWindow) {
    if (profile && facts.destination) {
      const destinationViolation = classifyDestination(facts.destination, profile);
      if (destinationViolation) return destinationViolation;
    }
    return { code: 'POPUP_NOT_SUPPORTED' };
  }

  if (facts.submitsForm && profile && facts.destination) {
    const destinationViolation = classifyDestination(facts.destination, profile);
    if (destinationViolation) return destinationViolation;
  }

  return null;
}


export async function guardedNavigateAbsolute(
  guard: DispatchGuard,
  epoch: number,
  page: Page,
  url: string,
  profile: Profile,
): Promise<void> {
  assertOriginAllowed(url, profile);
  await guard.run(epoch, page, () => performNavigate(page, url));
}

export async function guardedNavigateRelative(
  guard: DispatchGuard,
  epoch: number,
  page: Page,
  path: string,
  profile: Profile,
): Promise<void> {
  const url = new URL(path, profile.allowedOrigin).toString();
  assertOriginAllowed(url, profile);
  await guard.run(epoch, page, () => performNavigate(page, url));
}

export async function guardedFill(
  guard: DispatchGuard,
  epoch: number,
  locator: Locator,
  value: string,
): Promise<void> {
  await guard.run(epoch, locator.page(), () => performFill(locator, value));
}

export async function guardedClick(
  guard: DispatchGuard,
  epoch: number,
  locator: Locator,
  profile: Profile,
): Promise<void> {
  const page = locator.page();

  const facts = await describeClickTarget(locator).catch(() => null);
  if (facts) {
    const preViolation = classifyClick(facts, profile);
    if (preViolation) {
      guard.policy?.emit({ ...preViolation, phase: 'pre-dispatch', owner: guard.session.owner });
      throw new PolicyViolationError(`${preViolation.code} (pre-dispatch)`, {
        code: preViolation.code,
        phase: 'pre-dispatch',
      });
    }
  }

  const policy = guard.policy;
  if (!policy) {
    const before = page.url();
    await guard.run(epoch, page, () => performClick(locator));
    const after = page.url();
    if (after !== before) {
      assertOriginAllowed(after, profile);
    }
    return;
  }

  let captured: PolicyViolation | null = null;
  const unsubscribe = policy.subscribe((violation) => {
    if (captured || violation.phase !== 'network') return;
    if (violation.navigation || violation.code === 'POPUP_NOT_SUPPORTED' || violation.code === 'UNSAFE_METHOD') {
      captured = violation;
    }
  });
  let dispatchError: unknown;
  try {
    await guard.run(epoch, page, () => performClick(locator));
  } catch (error) {
    dispatchError = error;
  }
  await policy.settle(page).catch(() => {});
  unsubscribe();

  if (captured) {
    const violation: PolicyViolation = captured;
    throw new PolicyViolationError(`${violation.code} (network)`, { code: violation.code, phase: 'network' });
  }
  if (dispatchError) throw dispatchError;
}

export async function guardedExtract(guard: DispatchGuard, epoch: number, locator: Locator): Promise<string> {
  return guard.run(epoch, locator.page(), () => performExtract(locator));
}

export async function guardedReload(guard: DispatchGuard, epoch: number, page: Page): Promise<void> {
  await guard.run(epoch, page, () => performReload(page));
}
