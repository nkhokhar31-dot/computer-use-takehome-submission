# Computer-Use Automation Take-Home

**Product thesis:** the model discovers a workflow against a live local UI. A
typed, versioned JSON capability artifact becomes the contract.
Deterministic, model-free replay is the production execution path against
that contract. A human takes over the same live session when the system
cannot proceed safely.

Design write-up: [`REPORT.md`](./REPORT.md). Evidence index:
[`evidence/manifest.json`](./evidence/manifest.json).

## Status

This repo implements the full discovery-to-handoff thread: the target app,
the discovery loop (with its own stuck → human-intervention path), the
capability schema, model-free replay, session ownership/epoch/handoff,
bounded recovery, hard failures, network-level policy enforcement, masked
evidence, and a `node:test` regression suite.

"Live" below means a recorded CLI run in `evidence/runs/` (indexed in the
manifest); "unit-tested" means covered by `npm test`.

| Check | Status |
| --- | --- |
| Live discovery (real Anthropic call, real browser) | Done, live - `evidence/runs/discover-2026-09-15T22-24-34-249Z-1699a953.jsonl`, cited by the artifact's `discoveryProvenance.runId` |
| The exact generated artifact (not the curated one) replays, unmodified, with a changed member | Done, live - `evidence/runs/replay-2026-09-15T23-43-17-296Z-96016f72.jsonl` replays `capabilities/generated/member.balance.read.v1.1.0.discover-2026-09-15T22-24-34-249Z-1699a953.json` (git-ignored, never hand-edited) with a member other than the one discovery used; sha256 of that file recorded identical before and after |
| Changed-input replay, zero model calls | Done, live + unit-tested (`tests/replay-integration.test.ts`) |
| Missing-member business outcome | Done, live + unit-tested - `MEMBER_NOT_FOUND`, not a generic failure |
| Ambiguous target → `TARGET_AMBIGUOUS` | Done, unit-tested (`tests/ambiguous-target.test.ts`) |
| Malformed input rejected before any browser action | Done, CLI-verified (no unit test) - `fixtures/inputs/member-malformed.json` returns `INVALID_INPUT`, exit 1 |
| Bounded recovery, success and exhaustion | Done, live (success) + unit-tested (both paths) |
| Hard failure + masked screenshot | Done, live - `member-hardfail.json` returns `APPLICATION_ERROR`; masked PNG visually inspected; masking unit-tested (`tests/masking.test.ts`) |
| Browser or page loss → structured `SESSION_LOST` | Done, unit-tested (`tests/browser-loss.test.ts`, `tests/ownership.test.ts`) - a page or browser closed mid-navigation, between steps or while paused returns a failure naming the step, with `effect: unknown` after a dispatched click (never retried); other unexpected driver errors return `DRIVER_ERROR` |
| Allowlist: navigation, clicks, forms, redirects, popups | Done, unit-tested (`tests/policy.test.ts`, `tests/navigation-policy.test.ts`, `tests/replay-integration.test.ts`) - an off-policy destination is refused before dispatch or at the network layer before the request is sent, and reported as `POLICY_BLOCKED` |
| Risky-action / unsafe-method click gating | Done, unit-tested (`tests/risky-actions.test.ts`) - refused before the click dispatches, whatever the artifact's own `intent` claims |
| Human takeover during **replay** | Done, live + unit-tested - pause, payload, ownership transfer, resume validation, completion. Three curated runs: one declined, one with a scripted operator, one operated by a person (author-confirmed) with 4 sanitized `human_action` events |
| Human takeover during **discovery** | Done, live + unit-tested (`tests/discovery-policy.test.ts`) - `evidence/runs/discover-2026-09-15T22-25-27-417Z-edd53374.jsonl` reaches pause and a declined resume with a clean terminal event |
| Wrong-state resume stays paused | Done, live + unit-tested (`tests/takeover-recording.test.ts`, `tests/ownership.test.ts`) |
| Stale action rejected / in-flight work settles before takeover | Done, unit-tested (`tests/ownership.test.ts`) |
| Sanitized human-action capture | Done, live + unit-tested (`tests/takeover-recording.test.ts`) - closed-vocabulary click/change/key/navigation events, never text, values or URLs |
| Operator input closed while paused | Done, unit-tested (`tests/operator-input-closed.test.ts`) - stdin EOF or Ctrl-D ends the run `aborted` instead of waiting |
| Privacy across artifacts, logs, screenshots | Done, unit-tested (`tests/redaction.test.ts`, `tests/masking.test.ts`) - one bounded residual gap, see **Evidence** |
| Legacy mode: rank-1 strategy finds nothing, declared fallback resolves one | Done, unit-tested (`tests/legacy-mode.test.ts`) - the same 1.2.0 artifact replays end to end against the legacy DOM; reproducible below |
| Agent-facing capability catalog: list + invoke by id/version | Done, unit-tested (`tests/catalog.test.ts`) - `invoke` runs through the same `replay()` path as `replay --capability` |
| Automated test suite | `npm test` - 93 cases across 20 files, no API key needed |

Not implemented, deliberately: see [`REPORT.md` §7 Cuts](./REPORT.md#7-cuts)
(risky-action approval, a remote operator console, multi-tenant overrides,
desktop/frames, richer I/O types, and the stretch goals other than the
catalog).

## Reviewer guide - what to read, in order

1. **`capabilities/member.balance.read.v1.json`** - the artifact. Read
   `targets` first (note the `provenance` field - two are `authored`, the
   rest `observed`) and `blockers`/`postconditionRecovery` on the
   open-savings step, then the plain `steps` list.
2. **`src/schema.ts`** - what the artifact is allowed to say, and the
   replay result contract (§2 of `REPORT.md` explains the shape decisions).
3. **`src/replay.ts`** - the production path and its error contract. No
   Anthropic import anywhere in this file (a test enforces that statically).
4. **`src/runtime.ts`** - ownership, epoch, the serial dispatch guard, the
   network policy and pre-dispatch click classification.
5. **`src/operator.ts`** - the stdin operator prompt and sanitized takeover
   recording.
6. **`src/discovery.ts`** - the Anthropic loop, the compiler, and its own
   stuck → intervention path.
7. **`src/catalog.ts`** - the agent-facing capability catalog: `list`/
   `invoke` by explicit id+version, dispatching through the same `replay()`
   as the file-based command.
8. **`evidence/manifest.json`** - what each saved run shows and how it was
   verified.
9. **`REPORT.md`** - the seven-heading design write-up.

## Prerequisites

- Node.js 24 (`.nvmrc` pins this - `nvm use` if you have nvm; Playwright
  refuses to run at all under Node 16, which is what a system-wide `node`
  may resolve to even with `.nvmrc` present).
- An Anthropic **Console** API key, for `discover` and `control` only.
  `app`, `replay`, `list`, `invoke`, `typecheck` and `test` need no key and
  no external service. **A claude.ai Pro/Max subscription does not grant
  Console API credits** - they're billed separately at console.anthropic.com.
  A key on an account with no Console credits fails with
  `400: credit balance is too low`, not an auth error.

## Setup

```bash
nvm use                # or otherwise ensure `node --version` reports v24.x
npm ci
npx playwright install chromium
cp .env.example .env   # then fill in ANTHROPIC_API_KEY, ANTHROPIC_MODEL, APP_ORIGIN
```

`APP_ORIGIN` should be `http://localhost:3000` for local runs. `ANTHROPIC_MODEL`
is prefilled with `claude-sonnet-5`, the model that produced the shipped
discovery evidence; if it is left empty, discovery uses `claude-opus-5`. The `demo`
profile (`src/profile.ts`) allowlists that origin and the app's routes;
`src/runtime.ts` refuses any navigation or request outside them.

## Commands

**Start the target app** (keep this running in its own terminal):

```bash
npm run app
```

Serves on `http://localhost:3000` in `semantic` mode by default. `--mode
legacy` serves the same four routes and the same member data with a
weakly-labelled Member ID field (no real `<label>`) and table-based savings
values instead of a definition list - see **Try it yourself: legacy mode**
below. Fault behavior is built into both modes via reserved member ids
instead of a separate `--mode fault`, so the same fault states are reachable
regardless of which mode you're demonstrating. Look up any of these at
`http://localhost:3000/` (leading zeros preserved):

| Member ID | Behavior |
| --- | --- |
| `00123`, `00456`, `00789` | Normal - three different balances/statuses |
| `00999` (or any other unknown id) | No results - the `MEMBER_NOT_FOUND` case |
| `00500` | Session-expiry fault - shows a real "Session Expired" page with a real sign-in link until followed once (resets on `npm run app` restart) |
| `00600` | Bounded-recovery fault - savings page shows a "loading" interstitial for its first 2 requests, real content from the 3rd |
| `00700` | Hard-failure fault - savings page always shows real content plus an "Application Error" banner |

**Run live discovery** (needs the API key; opens a headed Chromium window,
calls Anthropic, compiles the resulting trace into a capability artifact):

```bash
npm run discover -- --profile demo \
                    --goal "Look up the requested member and read their savings account's balance, currency, and status" \
                    --input fixtures/inputs/member-a.json
```

Prints one `[discovery] turn N - ...` line per model action, then either
`[discover] goal completed in N turns: {...}` followed by the path it wrote
and the exact command to replay it, or `[discover] stuck after N turns:
<reason>` / `[discover] aborted after N turns: <reason>`.

**Discovery never writes to the reviewed artifact.** Each successful run
writes one immutable file of its own:

```text
capabilities/generated/member.balance.read.v1.1.0.<runId>.json
```

Replay that newly generated artifact with the path the command printed, e.g.:

```bash
npm run replay -- --profile demo \
                   --capability capabilities/generated/member.balance.read.v1.1.0.<runId>.json \
                   --input fixtures/inputs/member-a.json
```

It is stamped **1.1.0**, not 1.2.0, and that is deliberate: 1.1.0 is what
this pipeline produces (the compiled trace plus `authorSafetyRules()`'
identity checks, blockers and bounded recovery). The curated
`capabilities/member.balance.read.v1.json` is **1.2.0** because it adds one
*authored* rank-2 fallback strategy for the legacy surface that no discovery
run against the `semantic` app observes - so a fresh run cannot honestly
claim it, and the generated artifact does not replay against `--mode
legacy`. Use the curated artifact for the legacy demonstration below.
`capabilities/generated/` is git-ignored; `tests/generated-artifact-path.test.ts`
pins the rule that discovery output can never land on the curated path.
Because that directory is never committed, a reviewer who doesn't run
`discover` themselves can't see the raw file it wrote - so
`evidence/runs/replay-2026-09-15T23-43-17-296Z-96016f72.jsonl` commits proof
instead: it replays the exact generated file above, unmodified (sha256
checked identical before and after), with a member other than the one
discovery used, and returns that member's correct data with zero model
calls. See `evidence/manifest.json` for the full detail.

(On the filename: `...v1.json` pins the **major** version by convention; the
file's own `version` field carries the full semver, currently `1.2.0`.)

The loop stops after 25 actions, 120 seconds of active time (paused time
excluded), two consecutive malformed responses, or a `done` proposal that
passes a local check (at least one value extracted, every requested input
value still visible on screen). A `stuck` proposal, or the same action
repeated three times on the same URL, pauses for a human instead - see
**Discovery's own human handoff** below. An action the runtime policy refuses
is reported back to the model as `blocked by runtime policy (CODE)` and never
compiled into the artifact. See `src/discovery.ts`.

**Replay the compiled capability** - deterministic, zero Anthropic calls:

```bash
npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-a.json

npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-b.json      # changed input

npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-missing.json  # MEMBER_NOT_FOUND

npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-malformed.json  # INVALID_INPUT, no browser launched
```

Prints one JSON result: `{"type":"success","outputs":{...}}`, a
`{"type":"business_outcome","code":"MEMBER_NOT_FOUND",...}`, a
`{"type":"failure","step":...,"category":...,"expected":...,"observed":...,"effect":...}`,
or `{"type":"aborted",...}` after an intervention. Exit code is `0` for
success and business outcomes, `1` for failures and aborts. Replay opens a
**headed** browser (not headless) - on an intervention a human must be able
to operate this exact session, so a normal run just opens and closes a
visible window.

**Bounded recovery and hard failure** - no human needed, just watch the
window and the result:

```bash
npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-recovery.json  # 2 retries, succeeds within the declared bound of 3

npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-hardfail.json  # APPLICATION_ERROR, masked screenshot in evidence/escalation/
```

**Agent-facing capability catalog** - list every curated capability's typed
contract (id, version, goal, inputs, outputs), then call one by explicit
id+version without knowing its file path:

```bash
npm run list

npm run invoke -- --profile demo \
                   --id member.balance.read --version 1.2.0 \
                   --input fixtures/inputs/member-b.json
```

`invoke` is a lookup, not a second execution path: it resolves id+version to
a file under `capabilities/` via `src/catalog.ts`, then runs it through the
same `replay()` call the file-based `replay` command uses - same browser
launch, same `DispatchGuard`, same evidence writer, same result contract and
exit codes. Only top-level `capabilities/*.json` files are ever listed or
invokable by name; `capabilities/generated/` - discovery's per-run,
uncurated output - is always excluded, even if a generated file declares the
same id and version as a curated one (`tests/catalog.test.ts` proves this
directly). `--version` is always required and exact: there is no "latest".
An unknown id/version fails before any browser launches, with the same
`INVALID_ARTIFACT`-shaped pre-flight failure `replay` reports for a malformed
capability file.

### Try it yourself: real human takeover

A person-driven run of these steps is curated in `evidence/` (see
`evidence/manifest.json`). To reproduce it (restart `npm run app` first if
member `00500` has already been signed in this session):

```bash
npm run app                     # in one terminal, if it isn't already running
```

```bash
npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-expired.json
```

1. A headed Chromium window opens and the run pauses on member `00500`'s
   session-expiry fault. Your terminal prints the intervention payload
   (capability, step, reason, redacted screen, screenshot ref, session and
   control epoch) and prompts `Type "resume" ... or "abort"`.
2. **In the browser window** (not the terminal), click the real
   **"Sign in again"** link on the "Session Expired" page.
3. Back in the terminal, type `resume` and press Enter.
4. Expect: the run verifies the screen, identity, and checkpoint, then
   continues and finishes with `{"type":"success","outputs":{"balance":
   "2200.00","currency":"USD","status":"Active"}}`. The run's evidence file
   records your clicks and navigation as `human_action` events.

To see the "stays paused" path first: type `resume` *without* clicking
anything in step 2. Expect `Resume rejected: the blocker is still present.
The run stays paused.` and a re-prompt - then go click the link and resume
again, or type `abort` to stop cleanly. Closing the terminal's input instead
(Ctrl-D, or stdin redirected from `/dev/null`) also ends the run with
`{"type":"aborted",...,"reason":"operator input closed before a decision"}`.

**Discovery's own human handoff** (needs the API key - it calls the model).
This goal deliberately can't be completed, to force a stuck state:

```bash
npm run discover -- --profile demo \
                    --goal "Click the button labeled 'This Button Does Not Exist Anywhere' then call done." \
                    --input fixtures/inputs/empty.json
```

The model will fail to find the button, propose `stuck`, and discovery pauses
using the same ownership/epoch/stdin mechanism replay uses (no compiled
artifact is needed - it's discovery's own safety valve, not tied to any
capability). Type `resume` to watch it take a fresh observation and try
again (it will get stuck again, since nothing was actually fixed - still
within the original 25-action budget, not a reset one), or `abort` (or close
stdin) to stop cleanly.

### Try it yourself: legacy mode

Same capability, same 1.2.0 artifact, zero artifact changes - run against a
differently-shaped DOM instead:

```bash
npm run app -- --mode legacy    # in place of the plain `npm run app`
```

```bash
npm run replay -- --profile demo \
                   --capability capabilities/member.balance.read.v1.json \
                   --input fixtures/inputs/member-a.json
```

Watch the headed browser: the Member ID field has no `<label>` (a bare
`Member ID` text sits next to the input), and the savings page renders
Balance/Currency/Status as a plain table instead of a definition list. The
result is the same `{"type":"success","outputs":{...}}` as against
`semantic` mode. `target1`'s declared `label` strategy genuinely finds
nothing on this page; its declared rank-2 `nearbyText` fallback resolves the
field. `tests/legacy-mode.test.ts` asserts this directly (`getByLabel`
returns 0, `resolveTarget()` resolves via `strategyIndex: 1`) and also runs
the full replay. The Member ID field needed one new declared strategy
because a `label` strategy cannot resolve a field with no accessible label;
the table-based values needed no artifact change because `nearbyText`
covers both `dt`/`dd` and table/`span` adjacency.

**Sanity check** the discovery loop against a trivial page (needs the API
key):

```bash
npm run control
```

**Typecheck and regression tests** (no key, no external service):

```bash
npm run typecheck
npm test
```

## Evidence

**Start at [`evidence/manifest.json`](./evidence/manifest.json)** - a
hand-written index of every file in `evidence/`. It maps each run to its
scenario, the exact command that produced it, the capability version it ran
against, its result, and how it was verified (live, scripted operator, or
person-operated). All ten runs here were recorded in one session against the
code as submitted, including the fixes described in `REPORT.md` §7 - there
is no older, superseded or excluded set. The manifest also states what the
evidence cannot tell you: member ids are redacted, and events do not record
the app mode, so no run file can be claimed as the legacy-mode one.

Every `discover`/`replay` run writes a sanitized JSON-lines file to
`evidence/runs/<runId>.jsonl`. Discovery actions are recorded as a small
closed-vocabulary `intentCode` (`ENTER_PARAMETER`, `ACTIVATE_CONTROL`, ...)
plus, once resolved, the matching locator *strategy kind* - never the
model's free-text reasoning or the literal control text it read off the
page, because redaction cannot catch a value that was never declared
sensitive. One exception: a discovery `stuck` intervention keeps the model's
stated `reason` in its payload (redacted against declared-sensitive values)
so the operator knows why it stopped - see `REPORT.md` §6. Replay events carry each step's authored `intent` and outcome. A
hard failure or an intervention also captures a masked screenshot to
`evidence/escalation/<runId>-<stepId>.masked.png`: every declared-sensitive
field's element is blacked out, plus any other element that renders a
sensitive value verbatim (e.g. a heading embedding a member id); if that
coverage is ambiguous, the whole screenshot is suppressed
(`screenshotRef: "suppressed"`) rather than risking an unmasked value.

**Residual limitation:** a value never declared as a capability input/output
isn't guaranteed to be caught by any of the above. The one concrete case this
app has - the application-error page's `<h2>{name} ({id})</h2>`, where the
member's name is undeclared but shares an element with the declared,
tracked `memberId` - is covered: screenshot masking works at element
granularity, so masking the id blacks out the whole element, name included.
This was verified by inspecting the `member-hardfail.json` masked screenshot
and is pinned by `tests/masking.test.ts`, so a markup change that splits
name and id into separate elements fails that test instead of leaking
quietly. Nothing structurally prevents an undeclared value with no textual
overlap with anything declared from leaking in a future goal.

**Human takeover actions are captured, sanitized, not redacted:** while the
human holds control, `startTakeoverRecording` (`src/operator.ts`) records
their clicks, field changes, key presses, and navigations as
closed-vocabulary events (element kind, event kind, one of three
non-character keys, a route pattern) - never raw text, values, or
destinations, so there is nothing sensitive in them to redact.
`tests/takeover-recording.test.ts` types a real secret into a field during a
scripted takeover and asserts it never reaches the evidence file; the
curated person-operated run shows the same event shape. Any request the
network policy blocks on the human's own behalf is recorded too. Not
captured: mouse movement, scroll position, or the literal content typed.

## Notes

- `capabilities/member.balance.read.v1.json` is 1.2.0, compiled from a real
  `npm run discover` run against the `semantic` app plus authored additions
  (`authorSafetyRules()` in `src/discovery.ts`): two structural locator
  overrides for member-specific accessible names, an identity postcondition,
  the `MEMBER_NOT_FOUND` business outcome, two fault blockers, and a bounded
  recovery (1.1.0), plus one authored rank-2 fallback strategy on the Member
  ID target for the `legacy` app surface (1.2.0). Its `targets` map's
  `provenance` field shows which strategies were observed versus authored.
- `src/control.ts` is intentionally disposable - no abstractions, no tests -
  it exists only to isolate "the app is broken" from "the loop or prompt is
  broken."
- The ownership/epoch machinery lives in `src/runtime.ts` (session
  ownership, control epoch, the serial dispatch guard) and `src/operator.ts`
  (the stdin prompt and takeover recording), shared by `src/replay.ts`
  (blocker classification against a compiled capability's declared
  conditions, bounded recovery) and `src/discovery.ts` (its own
  `stuck`/dead-end escalation, which resumes with a fresh observation rather
  than validating a specific checkpoint).
- `guardedClick` (`src/runtime.ts`) enforces policy in three layers: a
  pre-dispatch check (`classifyClick`) refuses a risky-looking label, a form
  that statically submits with an unsafe method, or a statically-known
  off-policy form action before the click touches the page; a network-layer
  check (`attachNetworkPolicy`, attached by `replay()` and `discover`) routes
  every request in the session's browser context - navigations, redirects
  followed hop-by-hop, forms, script-driven `fetch`/`location.href`, and
  popups (closed outright) - through a request gate before it is sent; and a
  post-click URL re-check remains as a fallback for any caller that never
  attaches the network policy. `POLICY_BLOCKED`'s `effect` says which layer
  caught it: `none` pre-dispatch, `unknown` at the network layer, `confirmed`
  only in the fallback. Risky-action *approval* (escalating a flagged action
  to a human instead of blocking it) is not implemented.
- What each claim rests on: both discovery runs, replay outcomes, the hard
  failure, recovery, both replay takeovers (scripted and person-operated) and
  the discovery-side takeover all have curated run files. The network policy,
  risky-action gating, browser-loss handling, closed operator input and the
  stale-checkpoint resume fix (§7 of `REPORT.md`) are evidenced by tests
  only - no curated run exercises them.
