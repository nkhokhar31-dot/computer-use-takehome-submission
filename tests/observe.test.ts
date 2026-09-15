import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observe } from '../src/browser.js';

test('observe() walks an array-shaped ariaSnapshotJSON() root and is non-empty', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Test Heading</h1><button>Click me</button>');

    const raw = await page.ariaSnapshotJSON();
    assert.ok(Array.isArray(raw), 'expected Playwright to still return an array root - if this fails, the underlying API shape changed');

    const result = await observe(page);
    assert.notEqual(result, '', 'observe() must not silently return empty on a page with real content');
    assert.match(result, /heading/i);
    assert.match(result, /Test Heading/);
    assert.match(result, /button/i);
    assert.match(result, /Click me/);
  } finally {
    await browser.close();
  }
});

test('observe() returns empty string for a truly empty page', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div></div>');
    const result = await observe(page);
    assert.equal(result, '');
  } finally {
    await browser.close();
  }
});
