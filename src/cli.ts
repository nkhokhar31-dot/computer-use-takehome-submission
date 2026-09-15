import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import {
  runDiscovery,
  compile,
  authorSafetyRules,
  assertNotCuratedPath,
  generatedCapabilityPath,
  type InputDescriptor,
} from './discovery.js';
import { replay, validateInputs } from './replay.js';
import { DispatchGuard, attachNetworkPolicy, guardedNavigateRelative } from './runtime.js';
import { loadProfile } from './profile.js';
import { createEvidenceWriter, log } from './evidence.js';
import { parseCapability, type Capability, type ReplayResult } from './schema.js';
import { listCapabilities, resolveCapabilityPath } from './catalog.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const INPUT_DESCRIPTORS: Record<string, InputDescriptor> = {
  memberId: { description: 'The member identifier to search for.', sensitivity: 'sensitive' },
};

function describeInput(name: string): InputDescriptor {
  return (
    INPUT_DESCRIPTORS[name] ?? {
      description: `The "${name}" parameter, as provided by the caller.`,
      sensitivity: 'sensitive',
    }
  );
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

export function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read "${path}": ${message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`"${path}" is not valid JSON: ${message}`);
  }
}

export function loadInputsFile(inputPath: string): { ok: true; data: Record<string, unknown> } | { ok: false; result: ReplayResult } {
  let rawInputs: unknown;
  try {
    rawInputs = readJsonFile(inputPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      result: {
        type: 'failure',
        step: '(pre-flight)',
        category: 'INVALID_INPUT',
        expected: `a readable JSON object file at "${inputPath}"`,
        observed: message,
        effect: 'none',
      },
    };
  }
  const data = typeof rawInputs === 'object' && rawInputs !== null && !Array.isArray(rawInputs) ? (rawInputs as Record<string, unknown>) : {};
  return { ok: true, data };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) {
    throw new Error(`Missing required --${name} flag`);
  }
  return value;
}

async function runDiscoverCommand(flags: Record<string, string>): Promise<void> {
  const profileName = requireFlag(flags, 'profile');
  const goal = requireFlag(flags, 'goal');
  const inputPath = requireFlag(flags, 'input');

  const profile = loadProfile(profileName);
  const rawInputs = readJsonFile(inputPath);
  if (typeof rawInputs !== 'object' || rawInputs === null || Array.isArray(rawInputs)) {
    throw new Error('--input file must contain a JSON object of name -> string value');
  }
  const inputValues = rawInputs as Record<string, string>;
  const inputDescriptors: Record<string, InputDescriptor> = {};
  for (const name of Object.keys(inputValues)) {
    inputDescriptors[name] = describeInput(name);
  }

  const evidence = createEvidenceWriter('discover');

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);

  try {
    await attachNetworkPolicy(guard, profile);
    await guardedNavigateRelative(guard, guard.session.controlEpoch, page, profile.entryPath, profile);
    const result = await runDiscovery(page, goal, inputDescriptors, inputValues, profile, guard, evidence);

    if (!result.stuckReason && !result.aborted) {
      log('[discover] goal completed in', result.turns, 'turns; extracted:', Object.keys(result.outputs));

      const capabilityId = 'member.balance.read';
      const version = '1.1.0';
      const compiled = compile({
        capabilityId,
        version,
        profileId: profile.id,
        goal,
        inputDescriptors,
        trace: result.trace,
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
        runId: evidence.runId,
      });
      const authored = authorSafetyRules(compiled);
      const validated = parseCapability(authored);

      const outPath = generatedCapabilityPath(capabilityId, version, evidence.runId);
      assertNotCuratedPath(outPath);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(validated, null, 2)}\n`);
      log('[discover] wrote capability artifact to', outPath);
      log(
        `[discover] replay it with: npm run replay -- --profile ${profile.id} --capability ${outPath} --input ${inputPath}`,
      );
    } else {
      const label = result.aborted ? 'aborted' : 'stuck';
      log(`[discover] ${label} after`, result.turns, 'turns:', result.stuckReason);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function executeReplay(profileName: string, capabilityPath: string, inputPath: string): Promise<void> {
  const profile = loadProfile(profileName);

  let capability: Capability;
  try {
    capability = parseCapability(readJsonFile(capabilityPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify(
        {
          type: 'failure',
          step: '(pre-flight)',
          category: 'INVALID_ARTIFACT',
          expected: 'a valid capability artifact',
          observed: message,
          effect: 'none',
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const loadedInputs = loadInputsFile(inputPath);
  if (!loadedInputs.ok) {
    console.log(JSON.stringify(loadedInputs.result, null, 2));
    process.exitCode = 1;
    return;
  }
  const inputs = loadedInputs.data;

  const preflightError = validateInputs(capability, inputs);
  if (preflightError) {
    console.log(JSON.stringify(preflightError, null, 2));
    process.exitCode = 1;
    return;
  }

  const evidence = createEvidenceWriter('replay');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  const guard = new DispatchGuard(randomUUID(), page);

  try {
    const result = await replay(capability, inputs as Record<string, string>, profile, page, guard, evidence);
    console.log(JSON.stringify(result, null, 2));
    if (result.type === 'failure' || result.type === 'aborted') {
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runReplayCommand(flags: Record<string, string>): Promise<void> {
  const profileName = requireFlag(flags, 'profile');
  const capabilityPath = requireFlag(flags, 'capability');
  const inputPath = requireFlag(flags, 'input');
  await executeReplay(profileName, capabilityPath, inputPath);
}

async function runInvokeCommand(flags: Record<string, string>): Promise<void> {
  const profileName = requireFlag(flags, 'profile');
  const id = requireFlag(flags, 'id');
  const version = requireFlag(flags, 'version');
  const inputPath = requireFlag(flags, 'input');

  let capabilityPath: string;
  try {
    capabilityPath = resolveCapabilityPath(id, version);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify(
        { type: 'failure', step: '(pre-flight)', category: 'INVALID_ARTIFACT', expected: 'a known capability id/version', observed: message, effect: 'none' },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  await executeReplay(profileName, capabilityPath, inputPath);
}

function runListCommand(): void {
  console.log(JSON.stringify(listCapabilities(), null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (command === 'discover') {
    await runDiscoverCommand(flags);
  } else if (command === 'replay') {
    await runReplayCommand(flags);
  } else if (command === 'list') {
    runListCommand();
  } else if (command === 'invoke') {
    await runInvokeCommand(flags);
  } else {
    console.error(
      'Usage: cli.ts <discover|replay|list|invoke> --profile <name> [--goal ...] [--input ...] [--capability ...] [--id ...] [--version ...]',
    );
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
