# Computer-Use Automation Take-Home

An LLM discovers a workflow against a live local UI. That run compiles into a typed, versioned
JSON capability artifact. Deterministic, model-free replay is the production path against that
artifact. A human takes over the same live session when the system can't proceed safely.

Design write-up: [`REPORT.md`](./REPORT.md). Evidence index: [`evidence/manifest.json`](./evidence/manifest.json).

## Prerequisites

- Node.js 24 (`.nvmrc` pins this — run `nvm use` if you have nvm).
- An Anthropic **Console** API key, needed only for `discover` and `control`. `app`, `replay`,
  `list`, `invoke`, `typecheck`, and `test` need no key and no external service. A claude.ai
  Pro/Max subscription does **not** grant Console API credits — those are billed separately at
  console.anthropic.com.

## Setup

```bash
nvm use                # ensure `node --version` reports v24.x
npm ci
npx playwright install chromium
cp .env.example .env   # fill in ANTHROPIC_API_KEY; APP_ORIGIN=http://localhost:3000
```

## Demo path

**1. Start the target app** (keep running in its own terminal):

```bash
npm run app
```

Serves a local member-lookup app at `http://localhost:3000`. Reserved member IDs trigger the
runtime conditions replay has to handle:

| Member ID | Behavior |
| --- | --- |
| `00123`, `00456`, `00789` | Normal lookups, three different balances/statuses |
| `00999` (or any unknown id) | No results — `MEMBER_NOT_FOUND` |
| `00500` | Session-expiry fault (real "Session Expired" page, once per app run) |
| `00600` | Transient-load fault, resolves on the 3rd request |
| `00700` | Application-error fault (always) |

**2. Run the agent on a goal** (needs the API key; opens a headed browser, calls Anthropic,
compiles the run into a capability artifact):

```bash
npm run discover -- --profile demo \
                    --goal "Look up the requested member and read their savings account's balance, currency, and status" \
                    --input fixtures/inputs/member-a.json
```

Prints one line per model action, then the path of the artifact it wrote:
`capabilities/generated/member.balance.read.v1.1.0.<runId>.json`. That directory is git-ignored —
each run gets its own file and discovery can never overwrite the curated artifact below
(`assertNotCuratedPath`, pinned by `tests/generated-artifact-path.test.ts`).

**3. Replay the artifact discovery just produced** — deterministic, zero Anthropic calls:

```bash
npm run replay -- --profile demo \
                   --capability capabilities/generated/member.balance.read.v1.1.0.<runId>.json \
                   --input fixtures/inputs/member-a.json
```

That's the full loop the assignment asks for: goal → live LLM run → artifact → deterministic
replay. For a version of this artifact already reviewed and extended with error handling
(identity checks, business outcomes, fault blockers, bounded recovery — see `REPORT.md`'s Artifact
schema section), use
the curated one shipped in the repo:

```bash
npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-a.json      # success

npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-b.json      # changed input, same artifact

npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-missing.json  # MEMBER_NOT_FOUND, not a crash

npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-recovery.json  # bounded recovery, 2 retries then success

npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-hardfail.json  # APPLICATION_ERROR + masked screenshot

npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-malformed.json  # INVALID_INPUT, no browser launched
```

Each prints a structured result — `{"type":"success","outputs":{...}}`,
`{"type":"business_outcome","code":"MEMBER_NOT_FOUND",...}`, or
`{"type":"failure","step":...,"category":...,"expected":...,"observed":...,"effect":...}` — exit
code `0` for success/business outcomes, `1` for failures/aborts.

## Human takeover

Member `00500` triggers a session-expiry fault mid-run. Replay pauses, prints an intervention
payload, and waits on stdin — the human operates the **same** headed browser window, not a fresh
one:

```bash
npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-expired.json
```

In the browser window, click **"Sign in again"**; back in the terminal, type `resume`. The run
verifies the screen and checkpoint, then completes. Typing `resume` before fixing the browser
prints `Resume rejected: the blocker is still present` and stays paused; `abort` (or closing
stdin) ends the run cleanly. (Restart `npm run app` between attempts if `00500` was already
signed in this session.)

Discovery has its own stuck-escalation path — no capability needed:

```bash
npm run discover -- --profile demo \
                    --goal "Click the button labeled 'This Button Does Not Exist Anywhere' then call done." \
                    --input fixtures/inputs/empty.json
```

## Legacy surface

Same curated artifact, zero changes, against a differently-shaped DOM (no `<label>` on the
Member ID field, table-based savings values instead of a definition list):

```bash
npm run app -- --mode legacy
npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-a.json
```

The Member ID target's rank-1 `label` strategy finds nothing here; its declared rank-2
`nearbyText` fallback resolves it. `tests/legacy-mode.test.ts` asserts this directly.

## Agent-facing capability catalog

```bash
npm run list

npm run invoke -- --profile demo \
                   --id member.balance.read --version 1.2.0 \
                   --input fixtures/inputs/member-b.json
```

`invoke` resolves id+version to a file and runs it through the same `replay()` path as the
file-based command — not a second execution path.

## Tests

```bash
npm run typecheck
npm test          # 93 cases, no API key or external service needed
```

## What's here, what's cut

- `src/discovery.ts` — the Anthropic agent loop and the compiler that turns a trace into a
  capability.
- `src/schema.ts` — the capability contract and replay result types.
- `src/replay.ts` — the model-free replay interpreter (no Anthropic import anywhere in this file).
- `src/runtime.ts` — session ownership/epoch, the serial dispatch guard, policy enforcement.
- `src/operator.ts` — the human-takeover prompt and sanitized action recording.
- `capabilities/member.balance.read.v1.json` — the curated artifact.
- `evidence/` — real discovery and replay runs; see `evidence/manifest.json` for what each one
  shows and how it was verified.

What's deliberately left out, and why: [`REPORT.md`'s Cuts section](./REPORT.md#7-cuts).
