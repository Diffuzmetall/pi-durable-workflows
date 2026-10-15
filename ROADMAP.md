# Roadmap

Updated 2026-10-15. This roadmap carries the existing design forward into the public project. It separates the delivered sequential prototype from recommended next work and the wider deferred design.

The original design was narrowed to a sequential MVP in revision 6. The earlier revision-5 graph, catalog, control and adapter work remains future backlog. Publication of these plans does not approve implementation, spending, production activation or a release schedule. No dates or delivery commitments are assigned to unfinished milestones.

## Delivered baseline

The standalone OFFLINE DEMO runs registered agents sequentially, exposes CLI start/status/cancel, validates handoffs and stores results in native Durable SQLite. The public checkout supports `npm ci`, 65 fast checks and a real owner/CLI/native completed-reopen demo.

Controlled interruption after committed A, active cancellation and fail-closed uncertain-effect/identity reopening were verified before extraction. Their dedicated lifecycle fixtures have not yet been published as portable public checks. Live-model behavior and arbitrary crash recovery remain unverified.

See the [sequential MVP plan and acceptance boundary](docs/plans/sequential-mvp.md) and [verification record](docs/verification.md).

## Recommended next work

| Priority | Deliverable | Status | Plan |
|---|---|---|---|
| 1 | Make the existing controlled recovery/cancel/identity checks portable and reproducible from a public checkout | Recommended next; not implemented | [Next iteration](docs/plans/next-iteration.md) |
| 2 | Verify one real provider/model path with explicit opt-in and a fixed spending cap | Conditional; no live run authorized by this roadmap | [Provider admission](docs/plans/next-iteration.md#optional-real-provider-admission) |
| 3 | Add the smallest useful saved-definition catalog, stable worker reuse and actionable status | Deferred; select one bounded slice first | [U7, U9 and U10](docs/plans/workflow-expansion.md) |

Provider verification is a separate decision. Its spending gate does not block offline development or deterministic proof of graph semantics. License selection and any npm distribution are also owner decisions, not implied by this roadmap. The repository remains UNLICENSED until that choice is made.

## Wider capability roadmap

| Capability | Intended result | Main dependencies | Status |
|---|---|---|---|
| Saved scenarios and common compiler, U7 | List, show, validate and explain immutable versioned definitions | Existing admission and run snapshots | Deferred |
| Worker reuse, U9 | One owned conversation across sequential stages, without sharing it across parallel stages | Sequential baseline | Deferred |
| Results and actionable status, U10 | Outcome, evidence, artifact references, responsible actor and allowed actions | Baseline; worker integration when enabled | Partial baseline exists; richer model deferred |
| Parallel branches and joins, U3 | Independent branches overlap; each successor waits only for its required valid results | Baseline and stable branch identities | Deferred |
| Conditions and bounded dynamic expansion, U4 | Persist validated decisions and the exact expanded node set before dispatch | U3 | Deferred |
| Approval and durable events, U5 | Correlated events survive restart without lost wakeups or duplicate continuation admission | Persistent inbox/wakeup proof; graph integration only when needed | Deferred |
| Pause, resume and targeted retry, U11 | A persisted dispatch barrier and eligible new attempts preserve successful receipts | U3, U9, U10 and proven control inbox/wakeup | Deferred |
| Task-specific workflow drafts, U8 | A model or user proposes data, then validate/explain/admit/start use the same trusted path | U3, U4, U7, U9; gate execution needs U5 | Deferred |
| Reusable blocks, U12 | Versioned typed blocks expand into the same native runtime | U4, U7, U9, U10; pause/retry integration needs U11 | Deferred |
| Pocket adapter, U6 | Explicitly enabled host integration without making Pocket a core dependency | Baseline plus gates for each enabled capability | Optional, deferred |
| Beads/Dolt bridge, U13 | Authorized task dispatch and result correlation, with business acceptance separate from runtime success | U8, U10, U11, U12; external gates need U5 | Optional, deferred |

The unit IDs preserve the original plan's cross-references, not a numerical execution order. The old U1 feasibility work and U2 sequential execution were narrowed into the delivered MVP. Their original broader acceptance checklists must not be marked complete wholesale.

## How to choose and deliver the next slice

1. Start with the [next-iteration plan](docs/plans/next-iteration.md). Its first deliverable closes a reproducibility gap rather than adding a new runtime feature.
2. Select one subsequent capability and inspect its dependencies in the [expansion plan](docs/plans/workflow-expansion.md). Do not dispatch the entire backlog.
3. Record the smallest behavioral change, touched modules, failure cases and acceptance evidence before implementation. A plan is not authorization for external effects.
4. Reuse existing tests and fixtures. Run affected checks after changes and one necessary final pass. Do not introduce a new verification framework or repeat unchanged historical suites.
5. Keep status and evidence in [verification](docs/verification.md). Update this roadmap only when scope or accepted state changes.

## Constraints that do not change

Pi Durable remains the only scheduler and durable source of execution state. Model output is data, not an executable program or permission grant. Completed receipts are not replayed, uncertain effects require reconciliation, and foreign runs stay inaccessible.

New graph features must preserve budget, ownership, identity, validation and cancellation checks. Adapters stay outside core. No automatic deployment, publication, paid call, production change, database cleanup or workflow start follows from a roadmap item.

This is not a plan for distributed workers, a visual BPMN editor, a general cron/webhook platform or exactly-once external effects.
