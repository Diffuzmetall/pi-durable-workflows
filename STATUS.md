# Current status

Updated 2026-10-15. This repository is the working home for **pi-durable-workflows**. The public project, source, documentation and next-step plans are together here; future implementation belongs in this checkout rather than the earlier sandbox package.

## Working baseline

The sequential OFFLINE DEMO prototype is delivered and publicly published. Native Pi Durable remains the only scheduler. One foreground owner holds native SQLite; separate CLI processes provide start, status and cancel over authenticated local IPC.

| Area | Current state |
|---|---|
| Registered-agent sequence and validated handoffs | Working prototype |
| Native owner, CLI and saved result | Public reproducible demo |
| Completed close/reopen with retained receipts and budget accounting | Public reproducible demo |
| Fast admission, CLI and ownership checks | 65 passed on the extracted prototype |
| Strict application typecheck | Passed with TypeScript 7.0.2; compiler is not bundled |
| Controlled interruption after A, active-B cancel and blocked unsafe/identity reopening | Verified before extraction; portable public lifecycle checks still pending |
| Official dependencies | Locked SDK 1.2.0 packages; fresh installation was verified |
| License | UNLICENSED; no open-source license grant selected |

The public extraction was checked with `npm ci --ignore-scripts`, `npm test`, application typecheck and `npm run demo` on Linux with Node 24.19.0. The later roadmap and project-consolidation changes are documentation/archive changes, not new runtime verification.

The fixed demo result explicitly says it is not factual research. A successful deterministic result does not establish live-model quality or compatibility.

## Read these documents

| Document | Purpose |
|---|---|
| [README](README.md) | Install, run the offline demo and use the CLI |
| [Roadmap](ROADMAP.md) | Delivered baseline, priorities and deferred capabilities |
| [Sequential MVP plan](docs/plans/sequential-mvp.md) | The accepted first-delivery product contract |
| [Next iteration](docs/plans/next-iteration.md) | How to make controlled lifecycle checks portable |
| [Workflow expansion](docs/plans/workflow-expansion.md) | Dependencies and acceptance conditions for later features |
| [Verification](docs/verification.md) | Evidence boundaries and unverified claims |
| [Architecture](docs/architecture.md) | Modules, owner lifecycle and restart decisions |
| [Continuation guide](docs/continuation.md) | Where and how a fresh session should resume |
| [Agent instructions](AGENTS.md) | Rules for Pi and other coding agents in this checkout |

## Next recommended work

Port the existing controlled recovery/cancel/identity fixtures into a public, portable entry using the current official SDK packages. Reuse their actual checks and preserve the accepted core unless a concrete defect is reproduced. The detailed scope and done criteria are in the [next-iteration plan](docs/plans/next-iteration.md).

No implementation has been started for that iteration. A roadmap item is not an instruction to run the backlog. Real-provider admission is a separate opt-in decision with a fixed spending cap.

## Still unverified or deferred

Live-model calls and factual correctness, arbitrary crash recovery, a complete adversarial filesystem/lifecycle audit, capture-failure quarantine, Windows support and a published npm distribution are not established. The wider graph, gate, control, block and adapter design remains deferred.

Do not mistake completed-work reopening for interrupted recovery, controlled shutdown for an arbitrary crash, cancelled intent for settled effects, or runtime success for business acceptance.

## Local history and evidence

A maintainer checkout may also have an ignored `.local/` archive containing original plans/status notes, historical package/test sources, retained acceptance evidence and a continuation handoff. It is local context, not public repository content or runtime state authority. Clones do not receive it.

Archived databases are historical copies, not stores to reopen or continue. Their captures can retain original physical identities and paths. Do not rewrite evidence to match copied paths. Do not publish private artifacts or infer fresh execution from an archived PASS.
