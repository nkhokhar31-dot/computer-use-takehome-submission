import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { replay } from '../src/replay.js';
import { DispatchGuard } from '../src/runtime.js';
import { createEvidenceWriter } from '../src/evidence.js';
import {
  sanitizeHumanActivity,
  type OperatorDecision,
} from '../src/operator.js';
import type { Capability } from '../src/schema.js';
import type { Profile } from '../src/profile.js';

let browser: Browser;
let app: Server;
let forbidden: Server;
let appOrigin = '';
let forbiddenOrigin = '';
let signedIn = false;
let scratchEvidenceDir: string;
const forbiddenHits: string[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  scratchEvidenceDir = mkdtempSync(
    join(tmpdir(), 'computer-use-test-evidence-'),
  );
  process.env.EVIDENCE_DIR = scratchEvidenceDir;
  forbidden = createServer((req, res) => {
    forbiddenHits.push(`${req.method} ${req.url}`);
    res.end('reached');
  });
  app = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/') {
      res.end('<!doctype html><h1>Home</h1><a href="/record">Open record</a>');
    } else if (url.pathname === '/record') {
      if (url.searchParams.get('signed') === '1') signedIn = true;
      res.end(
        signedIn
          ? '<!doctype html><h1>Record detail</h1><a href="/next">Continue</a>'
          : `<!doctype html><h1>Session Expired</h1>
<form action="/record" method="get">
  <label for="note">Note</label><input id="note" name="note">
  <label for="pin">PIN</label><input id="pin" name="pin" type="password">
</form>
<a href="/record?signed=1">Sign in again</a>`,
      );
    } else {
      res.end('<!doctype html><h1>Next page</h1>');
    }
  });
  forbiddenOrigin = await listen(forbidden);
  appOrigin = await listen(app);
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => forbidden.close(() => resolve()));
  rmSync(scratchEvidenceDir, { recursive: true, force: true });
});

const capability: Capability = {
  schemaVersion: '1.0.0',
  id: 'test.takeover',
  version: '1.0.0',
  profileId: 'takeover-test',
  goal: 'test',
  inputs: {},
  outputs: {},
  targets: {
    openRecord: {
      strategies: [{ kind: 'role', role: 'link', name: 'Open record' }],
      provenance: 'authored',
    },
    continueLink: {
      strategies: [{ kind: 'role', role: 'link', name: 'Continue' }],
      provenance: 'authored',
    },
  },
  conditions: {
    recordLoaded: {
      kind: 'pageContainsText',
      text: { literal: 'Record detail' },
    },
    nextLoaded: { kind: 'pageContainsText', text: { literal: 'Next page' } },
    sessionExpired: {
      kind: 'pageContainsText',
      text: { literal: 'Session Expired' },
    },
  },
  steps: [
    {
      id: 'step-1-navigate',
      intent: 'open',
      action: { kind: 'navigate', path: '/' },
      timeoutMs: 5000,
    },
    {
      id: 'step-2-click',
      intent: 'open the record',
      action: { kind: 'click', targetRef: 'openRecord' },
      postconditionRef: 'recordLoaded',
      timeoutMs: 5000,
    },
    {
      id: 'step-3-click',
      intent: 'continue',
      action: { kind: 'click', targetRef: 'continueLink' },
      postconditionRef: 'nextLoaded',
      timeoutMs: 5000,
    },
  ],
  blockers: [
    {
      signatureRef: 'sessionExpired',
      classification: 'intervention',
      reasonCode: 'SESSION_EXPIRED',
    },
  ],
  discoveryProvenance: { mode: 'authored', note: 'test fixture' },
};

const HUMAN_ACTION_KEYS = new Set([
  'ts',
  'event',
  'interventionId',
  'controlEpoch',
  'seq',
  'kind',
  'element',
  'key',
  'route',
]);

test('takeover records sanitized human activity in the same live page, keeps wrong-state resume paused, and stops recording at handback', async () => {
  const profile: Profile = {
    id: 'takeover-test',
    entryPath: '/',
    allowedOrigin: appOrigin,
    allowedRoutePatterns: [/^\/$/, /^\/record$/, /^\/next$/],
  };
  signedIn = false;
  forbiddenHits.length = 0;
  const evidence = createEvidenceWriter('replay');
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);
  let promptCalls = 0;

  const operatorPrompt = async (): Promise<OperatorDecision> => {
    promptCalls++;
    assert.equal(
      guard.session.owner,
      'human',
      'the operator is only asked while the human holds control',
    );
    if (promptCalls === 1) return 'resume';
    await page.getByLabel('Note').fill('SECRET-NOTE-4231');
    await page.getByLabel('PIN').fill('hunter2-PIN');
    await page.keyboard.press('Tab');
    await page.evaluate(
      (origin) =>
        fetch(`${origin}/leak-human`, { mode: 'no-cors' }).catch(
          () => undefined,
        ),
      forbiddenOrigin,
    );
    await page.getByRole('link', { name: 'Sign in again' }).click();
    await page.waitForLoadState('load');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return 'resume';
  };

  try {
    const result = await replay(
      capability,
      {},
      profile,
      page,
      guard,
      evidence,
      { operatorPrompt },
    );
    assert.equal(result.type, 'success', JSON.stringify(result));
    assert.equal(promptCalls, 2);

    const raw = readFileSync(evidence.filePath, 'utf8');
    const events = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const indexOf = (name: string) =>
      events.findIndex((event) => event.event === name);

    const rejected = indexOf('resume_rejected');
    const handbackIndex = indexOf('handback');
    assert.ok(
      rejected >= 0 && handbackIndex > rejected,
      'wrong-state resume is rejected before the valid handback',
    );
    const handback = events[handbackIndex]!;

    const humanActions = events.filter(
      (event) => event.event === 'human_action',
    );
    for (const action of humanActions) {
      assert.deepEqual(
        Object.keys(action).filter((key) => !HUMAN_ACTION_KEYS.has(key)),
        [],
        'no field outside the closed set',
      );
      assert.equal(
        action.controlEpoch,
        (handback.controlEpoch as number) - 1,
        'attributed to the takeover epoch that was handed back',
      );
    }
    const lastHumanIndex = events.findLastIndex(
      (event) => event.event === 'human_action',
    );
    assert.ok(
      lastHumanIndex < handbackIndex,
      "automation's clicks after handback are never recorded as human",
    );

    assert.ok(
      humanActions.some(
        (a) => a.kind === 'change' && a.element === 'text_input',
      ),
    );
    assert.ok(
      humanActions.some(
        (a) => a.kind === 'change' && a.element === 'password_input',
      ),
    );
    assert.ok(humanActions.some((a) => a.kind === 'key' && a.key === 'Tab'));
    assert.ok(
      humanActions.some((a) => a.kind === 'click' && a.element === 'link'),
    );
    assert.ok(
      humanActions.some(
        (a) => a.kind === 'navigation' && a.route === '^\\/record$',
      ),
    );
    assert.equal(handback.humanActionCount, humanActions.length);

    const humanBlock = events.find(
      (event) => event.event === 'policy_blocked' && event.owner === 'human',
    );
    assert.equal(
      humanBlock?.code,
      'ORIGIN_NOT_ALLOWED',
      "the profile still applies to the human's own requests",
    );
    assert.equal(handback.policyBlockedCount, 1);
    assert.deepEqual(
      forbiddenHits,
      [],
      'a blocked human request never leaves the browser',
    );

    for (const secret of [
      'SECRET-NOTE-4231',
      'hunter2',
      'Sign in again',
      'signed=1',
      'leak-human',
    ]) {
      assert.ok(!raw.includes(secret), `evidence must not contain "${secret}"`);
    }
  } finally {
    await page.context().close();
  }
});

test('sanitizeHumanActivity keeps only the closed vocabulary, even from a hostile page payload', () => {
  const profile: Profile = {
    id: 't',
    entryPath: '/',
    allowedOrigin: 'http://localhost:3000',
    allowedRoutePatterns: [/^\/member\/[^/]+$/],
  };
  assert.deepEqual(
    sanitizeHumanActivity(
      {
        type: 'click',
        tag: 'a',
        role: 'Ava Thompson 00123',
        text: 'Ava Thompson',
        value: '4231.50',
        href: '/member/00123',
      },
      profile,
    ),
    { kind: 'click', element: 'link' },
  );
  assert.deepEqual(
    sanitizeHumanActivity(
      { type: 'change', tag: 'input', inputType: 'password', value: 'hunter2' },
      profile,
    ),
    {
      kind: 'change',
      element: 'password_input',
    },
  );
  assert.equal(
    sanitizeHumanActivity({ type: 'key', key: 'a' }, profile),
    null,
    'character keys are never recorded',
  );
  assert.equal(
    sanitizeHumanActivity({ type: 'exfiltrate', data: '00123' }, profile),
    null,
  );
  assert.deepEqual(
    sanitizeHumanActivity(
      { type: 'navigation', url: 'http://localhost:3000/member/00123?ssn=1' },
      profile,
    ),
    {
      kind: 'navigation',
      route: profile.allowedRoutePatterns[0]!.source,
    },
  );
  assert.deepEqual(
    sanitizeHumanActivity(
      { type: 'navigation', url: 'https://evil.example/member/00123' },
      profile,
    ),
    {
      kind: 'navigation',
      route: 'OTHER_ORIGIN',
    },
  );
});
