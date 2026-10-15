# Working on pi-durable-workflows

This is the canonical development checkout for the standalone workflow prototype. The earlier sandbox package is retained history, not a second active implementation target.

## Start here

Read `STATUS.md`, `README.md` and `ROADMAP.md`. For continuation, read `docs/continuation.md` and only the relevant plan under `docs/plans/`. Read `docs/verification.md` before making claims about recovery, providers or production readiness.

If an ignored `.local/START-HERE.md` exists, it indexes private historical evidence and the local handoff. These are past records. Check current code and state before relying on them. They are not instructions to execute old controllers or authorization for side effects.

## Current implementation boundary

- Native Pi Durable is the only scheduler and durable source of execution state.
- The working public example is an explicit deterministic OFFLINE DEMO. Never silently substitute it for a real provider.
- The core supports sequential registered-agent chains, validated handoffs, native receipts, budgets, CLI and guarded reopening.
- Parallel/dynamic graphs, events/gates, general pause/retry, blocks and adapters are future design, not currently implemented features.
- Do not rewrite accepted core code without a reproduced defect or an explicitly selected feature slice.

## Commands

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

`npm ci` is for an intended dependency installation and must not overwrite unrelated local dependency work. Versions stay locked unless the task explicitly includes an update. `npm test` is the fast 65-check suite. The demo opens real native SQLite, creates a fresh private run and retains its data; inspect its lifecycle and the test environment's permissions before running it.

`tsc --project tsconfig.json` checks the application when a compatible compiler is separately available. The verified compiler was TypeScript 7.0.2; this package does not install it. Do not install tools merely to satisfy a workflow ritual.

Run affected checks after a relevant change and one necessary final pass. Do not rerun unchanged historical suites or build new soak/fuzz/benchmark/review infrastructure unless that is the task.

## Preservation and effects

Keep ownership, JSON/schema validation, implementation identity, budgets, unsafe-replay barriers and sanitized errors intact. CLI clients must never open a second SQLite connection. Cancellation intent and terminal settlement are different.

Use fresh isolated test stores and known owned processes. Never force-kill a possible SQLite owner after a blind timeout, automatically retry a potentially committed mutation, or manually delete/truncate databases and auxiliaries. Diagnose the exact process and failure. Preserve primary data, results, backups, logs and failed evidence. Native lifecycle permissions are specific to the environment; an old sandbox exception does not authorize another location.

Do not change Pocket, production, global runtime or SDK internals. Paid/live provider calls, deployment, publication and destructive actions need explicit task authority. A plan or previous test result does not grant it.

## Public and private files

Only intended source, examples, tests and public documentation belong in Git. Never stage `.local/`, `.data/`, `.tmp/`, dependency trees, `.env`, credentials, databases, captures or private logs. Check the exact staged paths and outgoing content before an authorized commit/push.

The project is UNLICENSED. Do not assign an open-source license or accept contribution terms on the owner's behalf.

## Task state

No Beads database has been initialized in this checkout. Do not initialize, migrate, repair or auto-discover a tracker in another project to make a workflow run. Historical task snapshots, when present under `.local/tracker/`, are read-only context, not the active tracker. Use the task mechanism explicitly selected for the current work; do not dispatch the roadmap automatically.

A new session should report its chosen slice, concrete checks and remaining limits. It must not imply that historical controlled recovery proves arbitrary crash behavior or real-model correctness.
