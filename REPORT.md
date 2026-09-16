# REPORT

## 1. Architecture

A single Node/TypeScript process with five core modules: `discovery.ts` (Anthropic tool-use loop
and compiler), `replay.ts` (model-free interpreter), `runtime.ts` (ownership, serial dispatch,
policy), `browser.ts` (Playwright observation, locators, masking and request gate) and
`evidence.ts` (structured logging and redaction). `schema.ts` defines every serialized shape with
Zod; `operator.ts` holds the stdin operator prompt and takeover recording. The assignment tests
these boundaries rather than deployment, so there are no services or queues. Discovery and replay
act only through `runtime.ts`, so ownership and policy apply equally to model-chosen and
artifact-chosen actions.

**Observability.** Every `discover`/`replay` run writes one JSON-lines file to
`evidence/runs/<runId>.jsonl` via `evidence.ts`'s `EvidenceWriter` - not just what happened but
why: each replay event carries the step's `intent`, which precondition/postcondition/blocker
predicate fired, and the outcome; each discovery event carries a closed-vocabulary `intentCode`
plus the locator strategy that resolved, redacted against every tracked sensitive value before
it touches disk. A hard failure or an intervention additionally captures a masked screenshot to
`evidence/escalation/` (the Safety section below covers the masking). `evidence/manifest.json`
indexes which committed run demonstrates which scenario and how it was verified.

Perception is a filtered ARIA snapshot, and targets are accessible role, name and label strategies.
The accessibility tree survives non-semantic markup better than CSS selectors and exists on desktop;
coordinates would tie replay to pixels. Surfaces without a usable accessibility tree are not
covered. The target is a local Express app whose reserved member IDs produce session expiry, a
transient load and an application error as real HTML; `--mode legacy` removes the Member ID label
and renders values in a table. `list` and `invoke` expose curated capabilities by explicit id and
version through the same `replay()`.

## 2. Artifact schema

A capability (`capabilities/member.balance.read.v1.json`, 1.2.0) is a validated contract: id, semver
version, profile and goal; typed `inputs` and `outputs` with a `sensitivity` label; named `targets`
holding ranked locator strategies and `provenance: observed | authored`; reusable `conditions`;
ordered `steps` with pre/postconditions, timeouts, `zeroMatchOutcome` and bounded
`postconditionRecovery`; `blockers` mapping page signatures to classifications; and
`discoveryProvenance`. Compiled `fill` values are `{inputRef}` references, not literals, so one
artifact serves any member (the schema still permits `{literal}`; see Cuts below). A target's strategies are
tried in their declared rank order: zero matches tries the next, and more than one stops with
`TARGET_AMBIGUOUS`. Discovery records the first kind that resolves uniquely, probing role and name →
label → roleContains → nearbyText.

The steps were compiled from the saved live discovery run
(`evidence/runs/discover-2026-09-15T22-24-34-249Z-1699a953.jsonl`). `authorSafetyRules()` then adds
identity postconditions, the `MEMBER_NOT_FOUND` outcome, two structural locators replacing
member-specific names, blockers and a bounded recovery; 1.2.0 adds one fallback strategy for the
legacy surface. Replaced targets are marked `authored`, and `discoveryProvenance.note` lists the
other additions. These rules assume this goal's click order. Discovery writes to
`capabilities/generated/` and cannot overwrite the curated file. There is no top-level success field:
success means every postcondition held and every declared output was produced. Outputs are strings.

## 3. Determinism & error handling

`replay.ts` never imports the Anthropic SDK (a static test) and replays with no API key (a runtime
test). Each step checks its precondition, resolves its target fresh, dispatches through the serial
guard, checks blockers, then verifies its postcondition. Results separate:

- **Business outcome:** `MEMBER_NOT_FOUND`, from a declared zero match.
- **Recoverable condition:** a bounded reload on a postcondition miss; success and exhaustion are
  both tested.
- **Hard failure:** step, category, expected, observed and `effect` (`none` | `confirmed` |
  `unknown`) for invalid input or artifact (before a browser opens), missing or ambiguous target,
  condition failure, timeout, driver error, `POLICY_BLOCKED`, `APPLICATION_ERROR` and
  `SESSION_LOST`. A click with `unknown` effect is never retried automatically.

A page, context or browser closed at any point (mid-navigation, between steps or while paused)
returns `SESSION_LOST` for the step in progress, with `effect: unknown` if that step had dispatched a
click; other unexpected driver errors return `DRIVER_ERROR`. Details are one redacted line
(`tests/browser-loss.test.ts`).

Limits: dialogs are not handled (Playwright dismisses them), validation errors and permission denial
have no fixture, and `PERMISSION_DENIED` has no signature in the artifact.

## 4. Heterogeneity & multi-tenant

Artifacts store logical targets, never driver handles, selectors or coordinates; a driver resolves
them. The unchanged artifact replays against the legacy DOM, where rank 1 finds nothing and the
declared `nearbyText` fallback resolves one control (`tests/legacy-mode.test.ts`). Frames are not
scoped. A desktop driver would map the same strategy kinds onto platform accessibility roles, and use
window identity for policy and OS focus for takeover.

Multi-tenant reuse is design only: one capability per vendor product version plus a per-tenant
profile carrying origin, routes, label aliases and frame overrides. Overrides may change how targets
are found, never policy, identity checks or outputs. Capabilities would declare supported app
versions and refuse others; per-tenant not-found and ambiguous rates would signal drift.

## 5. Escalation & handoff

"Stuck" is a replay blocker classified `intervention` (session expiry), a discovery `stuck` proposal,
or the same discovery action on the same URL three times. `DispatchGuard` tracks session, owner,
epoch and lifecycle for one page. A transfer blocks new dispatch, settles in-flight work, sets
`owner: human` and increments the epoch; a stale-epoch, wrong-owner or wrong-page action is refused
before it is enqueued.

The human uses the same headed browser while the process waits on stdin. The payload carries
capability, version, goal, step, reason, last checkpoint, redacted URL, masked screenshot, session
and epoch. During the human's epoch, `startTakeoverRecording` records clicks, field changes,
Enter/Escape/Tab, navigations as route patterns and policy blocks, as closed-vocabulary events with no
text, values or URLs. Replay resumes only with a live page, the blocker gone and the checkpoint
holding, and then treats the interrupted step as done rather than dispatching it again; discovery
resumes with a fresh observation. If stdin is closed, or closes while paused, the run ends `aborted`
with `operator input closed before a decision` (`tests/operator-input-closed.test.ts`).

Evidence differs by path. Tests drive the operator from a script (`tests/takeover-recording.test.ts`,
`tests/discovery-policy.test.ts`). Saved run `replay-2026-09-15T22-25-46-471Z-94a476b7` used a
scripted operator. Saved run `replay-2026-09-15T22-26-25-753Z-7943b427` was operated by a person
(author-confirmed; a log cannot show who) and records four `human_action` events, a handback and
success. The discovery-side takeover has its own saved run too
(`discover-2026-09-15T22-25-27-417Z-edd53374`, an operator decline ending in a proper terminal
event), plus unit coverage in `tests/discovery-policy.test.ts`.

## 6. Safety

The profile (`src/profile.ts`) allowlists one origin and a set of route patterns; actions are limited
to navigate, fill, click and extract.

- **Pre-dispatch:** navigation is checked before it runs. `classifyClick` refuses a click whose live
  label contains a listed word (delete, remove, close, cancel, confirm, transfer, wire, withdraw,
  deactivate, terminate), a form submitting with a non-GET method or an off-policy static action, or
  a control that opens a new window.
- **Network:** `attachNetworkPolicy` (used by `replay()` and `discover`) checks every request in the
  browser context before it is sent, refusing off-origin requests, navigations to unlisted routes,
  methods other than GET/HEAD, each redirect hop, popups and WebSockets. This catches script-driven
  navigation, forms retargeted on submit and cross-origin redirects.
- **Fallback:** without the network policy, only a post-click URL check runs, which detects rather
  than prevents.

Blocks report `effect: none` before dispatch and `unknown` at the network layer; discovery returns
them to the model as codes and never compiles them into an artifact. `tests/navigation-policy.test.ts`
and `tests/risky-actions.test.ts` assert that request-counting forbidden servers receive nothing. No
saved run, including the live discovery run, contains a policy block, so these layers are evidenced
by tests only.

Risky actions are blocked rather than escalated. For a read-only capability a refusal cannot cause a
financial side effect, but no write capability can run. The GET/HEAD rule also applies to the human,
so a POST re-login could not be completed through takeover without widening the policy.

Sensitive inputs and extracted outputs feed one redaction registry for all evidence and payloads;
discovery action events store intent codes and strategy kinds, never model text or clicked labels.
The exception is a discovery `stuck` intervention, whose payload keeps the model's stated reason
(redacted against declared values) so the operator knows why it stopped.
Screenshots mask sensitive elements and are suppressed when a value appears more than once.
Undeclared values are not guaranteed: the error page's member name is masked only because it shares
an element with the member ID (`tests/masking.test.ts`).

## 7. Cuts

Deliberately left out, with what I would build next:

- **Risky-action approval.** Refused outright, so writes cannot run. Next: an `approvalRequired`
  step flag that raises an intervention and records the approval.
- **Risky-term coverage.** `classifyClick`'s word list (Safety, above) is a small, reviewable set, not an
  exhaustive or semantic classifier - a synonym outside it (e.g. "remit", "revoke") would not be
  blocked. Next: a per-profile override list, or a model-assisted classification step reviewed like
  any other authored rule rather than trusted blindly.
- **Operator routing and console.** An intervention is "routed" to the terminal that started the run
  (stdout payload, stdin decision) and the human uses that machine's headed browser. There is no
  queue, notification, remote or co-browsing console, and no operator identity or authorization:
  `owner` records `automation | human`, not which human. A caller without a terminal gets `aborted`,
  not a resumable `intervention_required`. Next: return that result from `invoke`, park the session,
  and expose it to an authenticated operator surface for a later resume.
- **Recovery vocabulary.** The only recoverable action is wait-and-reload on a postcondition miss.
  There is no "dismiss a known interstitial" click, and the risky-term list would refuse
  close/cancel/confirm anyway. Next: declared recovery actions bound to a blocker signature, exempt
  from the term list only for that signature.
- **Dialogs, validation errors, permission denial.** Unexercised. Next: a dialog handler classified
  against declared blockers, plus one fixture per class.
- **General-purpose compiler.** `discover` hardcodes the capability id (`member.balance.read`), its
  version (1.1.0), input descriptors and output sensitivity, and `authorSafetyRules()` assumes this
  goal's click order. Next: take the id and I/O contract from the caller, and keep authored rules as a
  separate, reviewed overlay file rather than code.
- **Richer contract and load-time validation.** Inputs and outputs are only `string`, with no format,
  numeric or enum types. `version` is not checked as semver. References between targets, conditions,
  inputs and outputs are resolved at run time rather than when the artifact is loaded, so a bad
  reference can surface after earlier steps have run, and an unknown target inside a condition reports
  `DRIVER_ERROR` instead of `INVALID_ARTIFACT`. The schema also accepts `{literal}` fill values, and
  discovery does not reject one proposed by the model, so a literal could be compiled into a generated
  artifact. Next: a load-time linter for references and types, and reject literal fills from discovery.
- **Multi-tenant reuse and drift.** Design only (see Heterogeneity & multi-tenant, above). There is
  one `demo` profile, and no tenant, app-version or override fields in the schema. Nothing measures
  drift. Next: `supportedAppVersions` on the capability, a per-tenant override layer limited to
  locator strategies, and per-tenant not-found/ambiguous rates.
- **Frames, desktop and vision.** Design only (same section). Perception is the ARIA snapshot alone, with no
  screenshot or coordinate fallback for surfaces without an accessibility tree. Next: a frame selector
  per target, then a platform accessibility driver behind `browser.ts`.
- **Structural redaction.** Undeclared-value coverage depends on markup. Next: mask page regions known
  to render member identity. Console output is now redacted consistently: `discover`'s status line
  reports output keys, not values, matching what the evidence writer already recorded; discovery's
  navigate/action/malformed-action failure messages are redacted against tracked sensitive values
  before they reach `log()` or the model-visible history, matching the redaction `replay.ts` already
  applies to its own failures. `replay`'s own result printing still returns real values on
  `success` - that's the deliberate return-to-caller contract, not a log.
- **Evidence depth.** No Playwright trace or DOM snapshot. Screenshots are taken only on escalation,
  and events do not record app mode or profile. Next: a redacted trace on failure.
- **Run orchestration.** One browser session per process, per-step timeouts but no whole-run deadline
  for replay, and no concurrency. Deliberately not built - the assignment explicitly discourages
  building scaling infrastructure before the core is proven.
- **Other stretch goals.** Only the capability catalog was built. Not attempted: confidence scoring
  and draft→approved gating, multi-run stability, code generation, bounded LLM-assisted fallback, and a
  cross-variant (two-tenant) demonstration with per-variant overrides.
