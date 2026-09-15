import type {
  APIResponse,
  BrowserContext,
  Frame,
  Page,
  Locator,
  Route,
} from 'playwright';
import {
  resolveValueRef,
  type Capability,
  type Condition,
  type LocatorStrategy,
  type Target,
} from './schema.js';

interface AriaNode {
  role: string;
  name?: string;
  text?: string;
  level?: number;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  children?: Array<string | AriaNode>;
  [key: string]: unknown;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'listbox',
]);

const LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'contentinfo',
  'region',
  'form',
  'search',
  'complementary',
  'article',
  'dialog',
  'alert',
  'alertdialog',
]);

const SHORT_MEANINGFUL = new Set(['0', 'no', 'ok', 'yes']);

function isLongText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 3;
}

function isShortMeaningful(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SHORT_MEANINGFUL.has(value.trim().toLowerCase())
  );
}

function shouldKeep(node: AriaNode): boolean {
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  if (node.role === 'heading') return true;
  if (LANDMARK_ROLES.has(node.role)) return true;
  if (isLongText(node.name) || isLongText(node.text)) return true;
  if (isShortMeaningful(node.name) || isShortMeaningful(node.text)) return true;
  return false;
}

function describe(node: AriaNode): string {
  const parts = [node.role];
  if (node.name) parts.push(`"${node.name}"`);
  if (node.text && node.text !== node.name) parts.push(`= "${node.text}"`);
  if (typeof node.level === 'number') parts.push(`level=${node.level}`);
  if (node.checked !== undefined) parts.push(`checked=${node.checked}`);
  if (node.disabled) parts.push('disabled');
  return parts.join(' ');
}

function walk(node: string | AriaNode, depth: number, lines: string[]): void {
  if (typeof node === 'string') {
    if (isLongText(node) || isShortMeaningful(node)) {
      lines.push(`${'  '.repeat(depth)}"${node.trim()}"`);
    }
    return;
  }

  const keep = shouldKeep(node);
  if (keep) {
    lines.push(`${'  '.repeat(depth)}${describe(node)}`);
  }

  const nextDepth = keep ? depth + 1 : depth;
  for (const child of node.children ?? []) {
    walk(child, nextDepth, lines);
  }
}

export async function observe(page: Page): Promise<string> {
  const snapshot = (await page.ariaSnapshotJSON()) as unknown as
    | AriaNode
    | AriaNode[]
    | null;
  if (!snapshot) return '';

  const lines: string[] = [];
  const roots = Array.isArray(snapshot) ? snapshot : [snapshot];
  for (const root of roots) {
    walk(root, 0, lines);
  }
  return lines.join('\n');
}

export type TargetResolution =
  | {
      outcome: 'resolved';
      locator: Locator;
      strategyIndex: number;
      strategy: LocatorStrategy;
    }
  | { outcome: 'zero' }
  | { outcome: 'ambiguous'; count: number; strategyIndex: number };

type AriaRoleArg = Parameters<Page['getByRole']>[0];

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const NEARBY_TEXT_LABEL_SELECTOR = 'dt, td, span, label';

function buildLocator(page: Page, strategy: LocatorStrategy): Locator {
  switch (strategy.kind) {
    case 'role':
      return strategy.name
        ? page.getByRole(strategy.role as AriaRoleArg, {
            name: strategy.name,
            exact: true,
          })
        : page.getByRole(strategy.role as AriaRoleArg);
    case 'roleContains':
      return page.getByRole(strategy.role as AriaRoleArg, {
        name: new RegExp(escapeRegExp(strategy.contains), 'i'),
      });
    case 'label':
      return page.getByLabel(strategy.text, { exact: true });
    case 'nearbyText':
      return page
        .locator(NEARBY_TEXT_LABEL_SELECTOR, { hasText: strategy.labelText })
        .locator('xpath=following-sibling::*[1]');
  }
}

export async function resolveTarget(
  page: Page,
  target: Target,
): Promise<TargetResolution> {
  for (let i = 0; i < target.strategies.length; i++) {
    const strategy = target.strategies[i]!;
    const locator = buildLocator(page, strategy);
    const count = await locator.count();
    if (count === 1) {
      return { outcome: 'resolved', locator, strategyIndex: i, strategy };
    }
    if (count > 1) {
      return { outcome: 'ambiguous', count, strategyIndex: i };
    }
  }
  return { outcome: 'zero' };
}

export interface ConditionCheck {
  passed: boolean;
  expected: string;
  observed: string;
}

export async function evaluateCondition(
  page: Page,
  condition: Condition,
  targets: Record<string, Target>,
  inputs: Record<string, string>,
): Promise<ConditionCheck> {
  switch (condition.kind) {
    case 'urlMatches': {
      const url = page.url();
      const passed = new RegExp(condition.pattern).test(url);
      return {
        passed,
        expected: `url matches ${condition.pattern}`,
        observed: url,
      };
    }
    case 'pageContainsText': {
      const expected = resolveValueRef(condition.text, inputs);
      const bodyText = (await page.locator('body').textContent()) ?? '';
      const passed = bodyText.includes(expected);
      return {
        passed,
        expected: `page contains "${expected}"`,
        observed: passed ? 'present' : 'absent',
      };
    }
    case 'fieldValueEquals': {
      const target = targets[condition.targetRef];
      if (!target) {
        throw new Error(
          `Unknown targetRef "${condition.targetRef}" referenced by a condition`,
        );
      }
      const resolution = await resolveTarget(page, target);
      const expected = resolveValueRef(condition.value, inputs);
      if (resolution.outcome !== 'resolved') {
        return {
          passed: false,
          expected,
          observed: `target ${resolution.outcome}`,
        };
      }
      const actual = await readFieldValue(resolution.locator);
      return { passed: actual === expected, expected, observed: actual };
    }
  }
}

export async function performNavigate(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'load' });
}

export async function performReload(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'load' });
}

export async function performFill(
  locator: Locator,
  value: string,
): Promise<void> {
  await locator.fill(value);
}

export async function performClick(locator: Locator): Promise<void> {
  await locator.click();
}

export async function performExtract(locator: Locator): Promise<string> {
  const text = await locator.textContent();
  return (text ?? '').trim();
}

export async function readFieldValue(locator: Locator): Promise<string> {
  return locator.inputValue();
}

export interface ClickTargetFacts {
  label: string;
  submitsForm: boolean;
  formMethod?: string;
  destination?: string;
  opensNewWindow: boolean;
}

export async function describeClickTarget(
  locator: Locator,
): Promise<ClickTargetFacts> {
  return locator.evaluate((node) => {
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const label = [
      el.innerText,
      (el as HTMLInputElement).value,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
    ]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' ');
    const sameWindowTargets = ['', '_self', '_parent', '_top'];

    const type = (
      el.getAttribute('type') ?? (tag === 'button' ? 'submit' : '')
    ).toLowerCase();
    const isSubmitControl =
      (tag === 'button' && type === 'submit') ||
      (tag === 'input' && (type === 'submit' || type === 'image'));
    const form = isSubmitControl ? (el as HTMLButtonElement).form : null;
    if (form) {
      const action =
        el.getAttribute('formaction') !== null
          ? (el as HTMLButtonElement).formAction
          : form.action;
      const formTarget =
        el.getAttribute('formtarget') ?? form.getAttribute('target');
      return {
        label,
        submitsForm: true,
        formMethod: (
          el.getAttribute('formmethod') ??
          form.getAttribute('method') ??
          'get'
        ).toLowerCase(),
        destination: /^https?:/i.test(action) ? action : undefined,
        opensNewWindow:
          formTarget !== null &&
          !sameWindowTargets.includes(formTarget.toLowerCase()),
      };
    }

    const anchor = el.closest('a[href]') as HTMLAnchorElement | null;
    const anchorTarget = anchor ? anchor.getAttribute('target') : null;
    return {
      label,
      submitsForm: false,
      destination:
        anchor && /^https?:/i.test(anchor.href) ? anchor.href : undefined,
      opensNewWindow:
        anchorTarget !== null &&
        !sameWindowTargets.includes(anchorTarget.toLowerCase()),
    };
  });
}

export type RawHumanActivity = Record<string, unknown>;

const HUMAN_ACTIVITY_BINDING = '__cuHumanActivity';

const HUMAN_ACTIVITY_SCRIPT = `(() => {
  if (window.__cuHumanActivityInstalled) return;
  window.__cuHumanActivityInstalled = true;
  const send = (payload) => { try { window.${HUMAN_ACTIVITY_BINDING}(payload); } catch (e) {} };
  const describe = (target) => {
    const el = target && target.closest ? (target.closest('a,button,input,select,textarea') || target) : null;
    if (!el || !el.tagName) return {};
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      inputType: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined,
    };
  };
  document.addEventListener('click', (e) => send(Object.assign({ type: 'click' }, describe(e.target))), true);
  document.addEventListener('change', (e) => send(Object.assign({ type: 'change' }, describe(e.target))), true);
  document.addEventListener('submit', () => send({ type: 'submit', tag: 'form' }), true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') send(Object.assign({ type: 'key', key: e.key }, describe(e.target)));
  }, true);
})();`;

const humanActivitySinks = new WeakMap<
  Page,
  { sink: ((activity: RawHumanActivity) => void) | null }
>();

export async function startHumanActivityCapture(
  page: Page,
  sink: (activity: RawHumanActivity) => void,
): Promise<() => void> {
  let state = humanActivitySinks.get(page);
  if (!state) {
    const created: { sink: ((activity: RawHumanActivity) => void) | null } = {
      sink: null,
    };
    humanActivitySinks.set(page, created);
    state = created;
    await page.exposeBinding(
      HUMAN_ACTIVITY_BINDING,
      (_source, payload: unknown) => {
        if (payload && typeof payload === 'object')
          created.sink?.(payload as RawHumanActivity);
      },
    );
    await page.addInitScript(HUMAN_ACTIVITY_SCRIPT);
  }
  for (const frame of page.frames()) {
    await frame.evaluate(HUMAN_ACTIVITY_SCRIPT).catch(() => {});
  }
  state.sink = sink;

  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame())
      sink({ type: 'navigation', url: frame.url() });
  };
  const onNewWindow = () => sink({ type: 'popup' });
  page.on('framenavigated', onNavigated);
  page.context().on('page', onNewWindow);

  const current = state;
  return () => {
    if (current.sink === sink) current.sink = null;
    page.off('framenavigated', onNavigated);
    page.context().off('page', onNewWindow);
  };
}

async function maskTextOccurrences(
  page: Page,
  values: string[],
): Promise<Locator[] | null> {
  const masks: Locator[] = [];
  for (const value of values) {
    if (!value) continue;
    const textLocator = page.getByText(value, { exact: false });
    const count = await textLocator.count();
    if (count > 1) return null;
    if (count === 1) masks.push(textLocator);
  }
  return masks;
}

export async function captureMaskedScreenshot(
  page: Page,
  capability: Capability,
  inputs: Record<string, string>,
  outputs: Record<string, string> = {},
): Promise<Buffer | null> {
  const maskLocators: Locator[] = [];

  for (const step of capability.steps) {
    let targetRef: string | undefined;
    let isSensitive = false;

    if (step.action.kind === 'extract') {
      targetRef = step.action.targetRef;
      isSensitive =
        capability.outputs[step.action.outputRef]?.sensitivity === 'sensitive';
    } else if (step.action.kind === 'fill' && 'inputRef' in step.action.value) {
      targetRef = step.action.targetRef;
      isSensitive =
        capability.inputs[step.action.value.inputRef]?.sensitivity ===
        'sensitive';
    }

    if (!isSensitive || !targetRef) continue;

    const target = capability.targets[targetRef];
    if (!target) return null;

    const resolution = await resolveTarget(page, target);
    if (resolution.outcome === 'ambiguous') return null;
    if (resolution.outcome === 'resolved')
      maskLocators.push(resolution.locator);
  }

  const sensitiveValues = [
    ...Object.entries(capability.inputs)
      .filter(([, field]) => field.sensitivity === 'sensitive')
      .map(([name]) => inputs[name]),
    ...Object.entries(capability.outputs)
      .filter(([, field]) => field.sensitivity === 'sensitive')
      .map(([name]) => outputs[name]),
  ].filter((value): value is string => !!value);

  const extraMasks = await maskTextOccurrences(page, sensitiveValues);
  if (extraMasks === null) return null;
  maskLocators.push(...extraMasks);

  return page.screenshot({ mask: maskLocators, type: 'png' });
}

export async function captureMaskedScreenshotForValues(
  page: Page,
  sensitiveValues: string[],
): Promise<Buffer | null> {
  const masks = await maskTextOccurrences(page, sensitiveValues);
  if (masks === null) return null;
  return page.screenshot({ mask: masks, type: 'png' });
}

export interface GateRequestInfo {
  url: string;
  method: string;
  navigation: boolean;
  resourceType: string;
  redirect: boolean;
}

export interface RequestGateHooks {
  decide(info: GateRequestInfo): string | null;
  onBlocked(info: GateRequestInfo, code: string): void;
  onNewWindow(page: Page): void;
  onWebSocketBlocked(): void;
}

export interface RequestGate {
  settle(page: Page, timeoutMs?: number): Promise<void>;
}

const GATE_QUIET_MS = 150;
const MAX_SUBRESOURCE_REDIRECTS = 10;

function isRedirect(response: APIResponse): boolean {
  return (
    response.status() >= 300 &&
    response.status() < 400 &&
    !!response.headers()['location']
  );
}

function redirectDocument(next: string): string {
  return `<!doctype html><meta charset="utf-8"><script>location.replace(${JSON.stringify(next).replace(/</g, '\\u003c')})</script>`;
}

export async function installRequestGate(
  context: BrowserContext,
  hooks: RequestGateHooks,
): Promise<RequestGate> {
  let inFlight = 0;
  let lastActivity = 0;
  const touch = () => {
    lastActivity = Date.now();
  };

  const block = async (route: Route, info: GateRequestInfo, code: string) => {
    hooks.onBlocked(info, code);
    await route.abort('blockedbyclient').catch(() => {});
  };

  await context.route('**/*', async (route) => {
    inFlight++;
    touch();
    try {
      const request = route.request();
      const base = {
        method: request.method(),
        navigation: request.isNavigationRequest(),
        resourceType: request.resourceType(),
      };
      const info: GateRequestInfo = {
        ...base,
        url: request.url(),
        redirect: false,
      };
      const code = hooks.decide(info);
      if (code) return await block(route, info, code);

      let response = await route.fetch({ maxRedirects: 0 });
      let currentUrl = request.url();
      for (let hop = 0; isRedirect(response); hop++) {
        const next = new URL(
          response.headers()['location']!,
          currentUrl,
        ).toString();
        const nextInfo: GateRequestInfo = {
          ...base,
          method: 'GET',
          url: next,
          redirect: true,
        };
        const nextCode =
          hop >= MAX_SUBRESOURCE_REDIRECTS
            ? 'TOO_MANY_REDIRECTS'
            : hooks.decide(nextInfo);
        if (nextCode) return await block(route, nextInfo, nextCode);
        if (base.navigation) {
          return await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: redirectDocument(next),
          });
        }
        response = await route.fetch({
          url: next,
          method: 'GET',
          maxRedirects: 0,
        });
        currentUrl = next;
      }
      await route.fulfill({ response });
    } catch {
      await route.abort('failed').catch(() => {});
    } finally {
      inFlight--;
      touch();
    }
  });

  await context.routeWebSocket(/.*/, (ws) => {
    touch();
    hooks.onWebSocketBlocked();
    ws.close().catch(() => {});
  });

  context.on('page', (page) => {
    touch();
    hooks.onNewWindow(page);
  });

  return {
    async settle(page, timeoutMs = 5000) {
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      while (Date.now() < deadline && !page.isClosed()) {
        await page
          .waitForLoadState('load', {
            timeout: Math.max(1, deadline - Date.now()),
          })
          .catch(() => {});
        const quietFor = Date.now() - Math.max(lastActivity, startedAt);
        if (inFlight === 0 && quietFor >= GATE_QUIET_MS) return;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(10, GATE_QUIET_MS - quietFor)),
        );
      }
    },
  };
}
