import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { DispatchGuard, PageContextError, guardedClick } from '../src/runtime.js';
import type { Profile } from '../src/profile.js';

let browser: Browser;

const profile: Profile = {
  id: 'test',
  entryPath: '/',
  allowedOrigin: 'http://localhost:9999',
  allowedRoutePatterns: [/^\/$/],
};

test.before(async () => {
  browser = await chromium.launch();
});

test.after(async () => {
  await browser.close();
});

test('guardedClick rejects a locator from a different page than the guard is bound to', async () => {
  const boundPage = await browser.newPage();
  const otherPage = await browser.newPage();
  try {
    await boundPage.setContent('<button>Click Me</button>');
    await otherPage.setContent('<button>Click Me</button>');

    const guard = new DispatchGuard(randomUUID(), boundPage);
    const locatorFromOtherPage = otherPage.getByRole('button', { name: 'Click Me' });

    await assert.rejects(
      () => guardedClick(guard, guard.session.controlEpoch, locatorFromOtherPage, profile),
      PageContextError,
    );
  } finally {
    await boundPage.close();
    await otherPage.close();
  }
});

test('guardedClick succeeds against a locator on the same page the guard is bound to', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button>Click Me</button>');
    const guard = new DispatchGuard(randomUUID(), page);

    await guardedClick(guard, guard.session.controlEpoch, page.getByRole('button', { name: 'Click Me' }), profile);
  } finally {
    await page.close();
  }
});
