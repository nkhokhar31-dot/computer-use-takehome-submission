import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCapability, type Capability } from './schema.js';

const CAPABILITIES_DIR = 'capabilities';

export type CatalogEntry =
  | {
      status: 'ok';
      id: string;
      version: string;
      path: string;
      goal: string;
      inputs: Capability['inputs'];
      outputs: Capability['outputs'];
    }
  | { status: 'invalid'; path: string; error: string };

export function listCapabilities(): CatalogEntry[] {
  const files = readdirSync(CAPABILITIES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(CAPABILITIES_DIR, entry.name))
    .sort();

  return files.map((path): CatalogEntry => {
    try {
      const capability = parseCapability(JSON.parse(readFileSync(path, 'utf8')));
      return {
        status: 'ok',
        id: capability.id,
        version: capability.version,
        path,
        goal: capability.goal,
        inputs: capability.inputs,
        outputs: capability.outputs,
      };
    } catch (error) {
      return { status: 'invalid', path, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function resolveCapabilityPath(id: string, version: string): string {
  const matches = listCapabilities().filter(
    (entry): entry is Extract<CatalogEntry, { status: 'ok' }> =>
      entry.status === 'ok' && entry.id === id && entry.version === version,
  );
  if (matches.length === 0) {
    throw new Error(
      `No curated capability found for id "${id}" version "${version}". Run the "list" command to see what's available.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous: ${matches.length} curated files declare id "${id}" version "${version}": ${matches.map((m) => m.path).join(', ')}.`,
    );
  }
  return matches[0]!.path;
}
