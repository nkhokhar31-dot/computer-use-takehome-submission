import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { runDiscovery } from './discovery.js';
import { DispatchGuard, attachNetworkPolicy, guardedNavigateRelative } from './runtime.js';
import { loadProfile } from './profile.js';
import { createEvidenceWriter, log } from './evidence.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

process.env.EVIDENCE_DIR ??= join(process.cwd(), 'evidence', 'tmp', 'control-sanity-check');

const profile = loadProfile('demo');
const goal = `Type "hello from the agent loop" into the Message field, click Submit, then once the page shows the submitted message, call "done".`;

const evidence = createEvidenceWriter('discover');

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ serviceWorkers: 'block' });
const guard = new DispatchGuard(randomUUID(), page);
await attachNetworkPolicy(guard, profile);
await guardedNavigateRelative(guard, guard.session.controlEpoch, page, '/control', profile);

const result = await runDiscovery(page, goal, {}, {}, profile, guard, evidence);

if (result.stuckReason) {
  log('[control] stuck after', result.turns, 'turns:', result.stuckReason);
} else {
  log('[control] goal completed in', result.turns, 'turns');
}

await browser.close();
