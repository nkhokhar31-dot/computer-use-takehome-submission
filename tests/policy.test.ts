import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { DispatchGuard, PolicyViolationError, guardedClick, guardedNavigateAbsolute, guardedNavigateRelative } from '../src/runtime.js';
import type { Profile } from '../src/profile.js';
import { app } from '../target-app/server.js';

const profile: Profile = {
  id: 'test',
  entryPath: '/',
  allowedOrigin: 'http://localhost:9999',
  allowedRoutePatterns: [/^\/$/, /^\/member\/[^/]+$/],
};

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch();
});

test.after(async () => {
  await browser.close();
});

let server: Server;
let appOrigin: string;
let appProfile: Profile;

test.before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  appOrigin = `http://localhost:${(server.address() as AddressInfo).port}`;
  appProfile = {
    id: 'demo',
    entryPath: '/',
    allowedOrigin: appOrigin,
    allowedRoutePatterns: [/^\/$/, /^\/search$/, /^\/member\/[^/]+$/, /^\/member\/[^/]+\/savings$/],
  };
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('guardedClick allows a click that navigates within the allowlist (no false positive on the golden path)', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${appOrigin}/search?memberId=00123`);
    const guard = new DispatchGuard('click-policy-allowed', page);
    await guardedClick(guard, guard.session.controlEpoch, page.getByRole('link'), appProfile);
    assert.match(page.url(), /\/member\/00123$/, 'the click must have actually navigated, or this test proves nothing');
  } finally {
    await page.close();
  }
});

test('guardedClick refuses a click that navigates outside the allowlisted routes - the disclosed gap, now closed', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${appOrigin}/member/00123`);
    await page.setContent('<a href="/not-an-allowed-route">Escape</a>');
    const guard = new DispatchGuard('click-policy-blocked', page);

    await assert.rejects(
      () => guardedClick(guard, guard.session.controlEpoch, page.getByRole('link', { name: 'Escape' }), appProfile),
      PolicyViolationError,
    );
    assert.match(page.url(), /\/not-an-allowed-route$/, 'the check runs after the click actually navigated, not instead of it');
  } finally {
    await page.close();
  }
});

test('guardedClick ignores a click that causes no navigation at all (no false positive from a stale pre-navigation URL)', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button>Click Me</button>');
    const guard = new DispatchGuard('click-policy-no-nav', page);
    await guardedClick(guard, guard.session.controlEpoch, page.getByRole('button', { name: 'Click Me' }), profile);
  } finally {
    await page.close();
  }
});

test('navigation outside the allowed origin is refused, never dispatched', async () => {
  const page = await browser.newPage();
  const guard = new DispatchGuard('policy-test-1', page);
  try {
    await assert.rejects(
      () => guardedNavigateAbsolute(guard, guard.session.controlEpoch, page, 'http://example.com/', profile),
      PolicyViolationError,
    );
    assert.equal(page.url(), 'about:blank', 'a refused navigation must never actually load the page');
  } finally {
    await page.close();
  }
});

test('navigation to a route not on the allowlist is refused even within the allowed origin', async () => {
  const page = await browser.newPage();
  const guard = new DispatchGuard('policy-test-2', page);
  try {
    await assert.rejects(
      () => guardedNavigateAbsolute(guard, guard.session.controlEpoch, page, 'http://localhost:9999/not-allowed', profile),
      PolicyViolationError,
    );
  } finally {
    await page.close();
  }
});

test('a relative path resolves against the allowed origin and is accepted when it matches an allowed route pattern', async () => {
  const page = await browser.newPage();
  const guard = new DispatchGuard('policy-test-3', page);
  try {
    await assert.rejects(
      () => guardedNavigateRelative(guard, guard.session.controlEpoch, page, '/member/00123', profile),
      (error: unknown) => !(error instanceof PolicyViolationError),
    );
  } finally {
    await page.close();
  }
});

test('an unparsable URL is refused rather than throwing an unhandled error type', async () => {
  const page = await browser.newPage();
  const guard = new DispatchGuard('policy-test-4', page);
  try {
    await assert.rejects(
      () => guardedNavigateAbsolute(guard, guard.session.controlEpoch, page, 'not a url', profile),
      PolicyViolationError,
    );
  } finally {
    await page.close();
  }
});
