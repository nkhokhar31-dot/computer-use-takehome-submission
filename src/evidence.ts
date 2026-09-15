import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /[A-Za-z0-9+/]{40,}={0,2}/g,
];

const SECRET_ENV_NAME_PATTERN = /API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

function sensitiveEnvValues(): string[] {
  return Object.entries(process.env)
    .filter((entry): entry is [string, string] => !!entry[1] && entry[1].length >= 6)
    .filter(([name]) => SECRET_ENV_NAME_PATTERN.test(name))
    .map(([, value]) => value);
}

export function redact(text: string, extraSecrets: string[] = []): string {
  let output = text;

  for (const value of extraSecrets) {
    if (value) output = output.split(value).join('[REDACTED]');
  }

  for (const value of sensitiveEnvValues()) {
    output = output.split(value).join('[REDACTED]');
  }

  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }

  return output;
}

export function log(...parts: unknown[]): void {
  const rendered = parts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .map((part) => redact(part))
    .join(' ');
  console.log(rendered);
}

export interface EvidenceWriter {
  runId: string;
  filePath: string;
  record(event: object): void;
  saveScreenshot(buffer: Buffer | null, stepId: string): string;
  trackSensitive(...values: Array<string | undefined>): void;
  knownSensitiveValues(): string[];
}

function evidenceRoot(): string {
  return process.env.EVIDENCE_DIR || join(process.cwd(), 'evidence');
}

export function createEvidenceWriter(kind: 'discover' | 'replay'): EvidenceWriter {
  const root = evidenceRoot();
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const runId = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const filePath = join(runsDir, `${runId}.jsonl`);
  const sensitiveValues: string[] = [];

  return {
    runId,
    filePath,
    record(event) {
      const raw = JSON.stringify({ ts: new Date().toISOString(), ...event });
      appendFileSync(filePath, `${redact(raw, sensitiveValues)}\n`);
    },
    saveScreenshot(buffer, stepId) {
      if (!buffer) return 'suppressed';
      const escalationDir = join(root, 'escalation');
      mkdirSync(escalationDir, { recursive: true });
      const relPath = join(escalationDir, `${runId}-${stepId}.masked.png`);
      writeFileSync(relPath, buffer);
      return relPath;
    },
    trackSensitive(...values) {
      for (const value of values) {
        if (value) sensitiveValues.push(value);
      }
    },
    knownSensitiveValues() {
      return [...sensitiveValues];
    },
  };
}
