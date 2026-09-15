import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { captureMaskedScreenshot, captureMaskedScreenshotForValues } from '../src/browser.js';
import type { Capability } from '../src/schema.js';

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch();
});

test.after(async () => {
  await browser.close();
});

function isPng(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

const baseCapability: Capability = {
  schemaVersion: '1.0.0',
  id: 'test.masking',
  version: '1.0.0',
  profileId: 'demo',
  goal: 'test',
  inputs: { memberId: { type: 'string', sensitivity: 'sensitive', description: 'test' } },
  outputs: { balance: { type: 'string', sensitivity: 'sensitive', description: 'test' } },
  targets: {
    balanceValue: { strategies: [{ kind: 'nearbyText', labelText: 'Balance' }], provenance: 'authored' },
  },
  conditions: {},
  steps: [
    { id: 'step-1', intent: 'extract', action: { kind: 'extract', targetRef: 'balanceValue', outputRef: 'balance' }, timeoutMs: 1000 },
  ],
  blockers: [],
  discoveryProvenance: { mode: 'authored', note: 'test fixture' },
};

test('captureMaskedScreenshot masks a declared-sensitive target and captures normally', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<dl><dt>Balance</dt><dd>4231.50</dd></dl>');
    const buffer = await captureMaskedScreenshot(page, baseCapability, { memberId: '00123' });
    assert.ok(buffer, 'a resolvable, unambiguous sensitive field must not suppress the screenshot');
    assert.ok(isPng(buffer!), 'the captured buffer must be a valid PNG');
  } finally {
    await page.close();
  }
});

test('captureMaskedScreenshot suppresses the whole screenshot when a sensitive input value renders in more than one place', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<h1>Member 00123</h1><dl><dt>Balance</dt><dd>4231.50</dd></dl><p>00123</p>');
    const buffer = await captureMaskedScreenshot(page, baseCapability, { memberId: '00123' });
    assert.equal(buffer, null, 'ambiguous coverage of a sensitive value must suppress the screenshot rather than guess');
  } finally {
    await page.close();
  }
});

test('captureMaskedScreenshot proceeds normally when a sensitive input value simply is not on screen', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<dl><dt>Balance</dt><dd>4231.50</dd></dl>');
    const buffer = await captureMaskedScreenshot(page, baseCapability, { memberId: '00999' });
    assert.ok(buffer, 'zero matches for a sensitive value means nothing to mask, not uncertainty');
  } finally {
    await page.close();
  }
});

test('captureMaskedScreenshot also masks an already-extracted sensitive output value rendered outside its declared target', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<dl><dt>Balance</dt><dd>4231.50</dd></dl><p>Summary: 4231.50</p>');
    const buffer = await captureMaskedScreenshot(page, baseCapability, { memberId: '00123' }, { balance: '4231.50' });
    assert.equal(buffer, null, 'an extracted sensitive value rendered a second time outside its target must suppress, not leak unmasked');
  } finally {
    await page.close();
  }
});

test('captureMaskedScreenshot masks normally when an extracted sensitive output only renders once', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<dl><dt>Balance</dt><dd>4231.50</dd></dl>');
    const buffer = await captureMaskedScreenshot(page, baseCapability, { memberId: '00123' }, { balance: '4231.50' });
    assert.ok(buffer, 'a single-occurrence extracted value must not suppress the screenshot');
    assert.ok(isPng(buffer!));
  } finally {
    await page.close();
  }
});

test('captureMaskedScreenshotForValues (discovery path, no capability) masks by rendered value alone', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<h1>Member 00123</h1><p>Balance: 4231.50</p>');
    const buffer = await captureMaskedScreenshotForValues(page, ['00123', '4231.50']);
    assert.ok(buffer, 'unambiguous single-occurrence values must be masked and captured, not suppressed');
    assert.ok(isPng(buffer!));
  } finally {
    await page.close();
  }
});

test('precisely bounding the disclosed undeclared-value gap: the real app\'s "name (id)" heading shares one element, so masking the declared id incidentally covers the undeclared name too', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<h2>Riley Chen (00700)</h2><div role="alert">Application Error</div>');
    const locator = page.getByText('00700', { exact: false });
    assert.equal(await locator.count(), 1, 'the id must resolve to exactly one element for masking to apply at all');
    const text = await locator.textContent();
    assert.match(
      text ?? '',
      /Riley Chen/,
      'the element masking will cover must also contain the undeclared name, or the name renders unmasked',
    );
  } finally {
    await page.close();
  }
});

test('captureMaskedScreenshotForValues suppresses on an ambiguous value occurrence', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<h1>00123</h1><p>00123</p>');
    const buffer = await captureMaskedScreenshotForValues(page, ['00123']);
    assert.equal(buffer, null);
  } finally {
    await page.close();
  }
});
