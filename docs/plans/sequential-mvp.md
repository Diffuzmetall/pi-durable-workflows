# Sequential MVP plan and accepted baseline

Status: delivered as a working OFFLINE DEMO prototype. This is a public adaptation of the approved revision-6 plan, not a new implementation assignment. It supersedes the older wide graph design for the first delivery.

## User outcome

A user describes a JSON chain of registered agents, starts it through the CLI, receives a run ID, and reads a saved result. A new owner can continue unfinished work from a known-safe committed boundary without repeating completed stages.

The first delivery has no Pocket or Beads runtime dependency. It uses native Durable tasks, conversations, checkpoints, documents and SQLite. It does not add another scheduler, execution journal or generated-JavaScript executor.

## Product requirements

| ID | Requirement | Acceptance boundary |
|---|---|---|
| MVP-R1 | Standalone sequential registered-agent chains | Bare owner/CLI works; B receives only the validated declared result of A |
| MVP-R2 | CLI start, status and cancel | ID and actual result/reason are visible; failed or invalid output never admits the next step |
| MVP-R3 | Native persistence and immutable run snapshots | Definition, inputs and implementation identities are fixed at start; receipts remain durable |
| MVP-R4 | Ownership, limits and safe recovery | Foreign access/capability escalation fail; unknown effects do not replay automatically |

## Implementation path that was delivered

| Unit | Work | Recorded result |
|---|---|---|
| MVP1 | Strict JSON admission, native run with owned stages, result contracts, budget guards and immutable receipts | Accepted in the bounded sequential prototype |
| MVP2 | Thin authenticated CLI, one foreground owner and a runnable registered-agent example | Accepted with real executable processes and official SDK packages |
| MVP3 | Controlled interrupted continuation, active cancellation, retained state and fail-closed reopening | Accepted with explicitly labeled controlled lifecycle checks, not arbitrary crash proof |

The foreground owner acquires its participating-process endpoint before opening SQLite. CLI processes never open their own database connection. The owner remains alive to execute work; returning a run ID does not create a background daemon.

At reopen, exclusive ownership, native preflight and budget verification must all pass before execution resumes. A `marked` cancellation response is an intent, not proof of terminal settlement. A trusted implementation mismatch blocks further execution.

## Required behavioral checks

- A→B→C completes with validated handoffs and a stored final result.
- Invalid, duplicate or unknown steps are rejected before effects. Failed, missing or domain-invalid results cannot admit a successor.
- Another owner cannot read or cancel a run, and a definition cannot inject capabilities.
- Completed reopening retains receipts and accounting without replay.
- After an orderly stop at committed A, a new process calls only B/C. A identity, raw records and its first budget debit remain unchanged.
- Cancelling active B prevents C and automatic continuation after restart. Unresolved reservations remain visible.
- An uncertain B effect and incompatible implementation identity block new calls.

The [verification record](../verification.md) distinguishes the public demo and fast suite from the historical dedicated service/IPC lifecycle workers. Deterministic provider output proves mechanism behavior, not real-model correctness. The independent QA requirement was explicitly waived for the bounded prototype; no new independent QA PASS is claimed.

## Excluded from the first delivery

Parallel joins, conditional/dynamic topology, event/approval gates, same-worker reuse, catalog/YAML management, model-proposed definitions, targeted retry, user-facing pause/resume, blocks, notifications, UI and host/tracker adapters are not prerequisites of this MVP.

Restart continuation is part of the baseline. A general user-facing pause/resume feature is not. Healthy completed reopening is not interrupted recovery, and controlled interruption is not arbitrary crash recovery.

## What remains after acceptance

The next useful step is to publish the already proven controlled lifecycle checks as portable public regressions. Live-provider admission, arbitrary crash/failure injection, production hardening, license choice and npm distribution remain separate decisions or unverified scopes.

Acceptance of this sequential prototype does not close the original wider design. Continue with the [next-iteration plan](next-iteration.md) and [deferred expansion plan](workflow-expansion.md).
