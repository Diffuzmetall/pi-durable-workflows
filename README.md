# pi-durable-workflows

A working prototype for **sequential, persistent agent workflows on Pi Durable**.

Start with [current status](STATUS.md), the [roadmap](ROADMAP.md) and the [continuation guide](docs/continuation.md). This repository is the working home for subsequent development. [Agent instructions](AGENTS.md) cover Pi and other coding agents.

Describe a chain of registered agents in JSON, start it through the CLI, and inspect the run and saved results. Native Durable tasks and SQLite hold execution state. One foreground owner runs the workflow; separate CLI processes communicate with it through authenticated local IPC.

**Prototype, not production-ready.** The reproducible example is an explicit **OFFLINE DEMO** using the official SDK Faux provider. It verifies execution, validation, persistence and guards. It does not call a real model, perform factual research or prove live-provider compatibility.

## Try the offline demo

Requirements: Node **24.19.0 or newer**, npm, and a POSIX environment. The verified environment is Linux with Node 24.19.0. SDK dependencies are pinned to official 1.2.0 packages in the lockfile. No custom SDK loader or source checkout is needed.

```sh
git clone https://github.com/Diffuzmetall/pi-durable-workflows.git
cd pi-durable-workflows
npm ci --ignore-scripts
npm test
npm run demo
```

The demo starts the real owner and CLI, executes `researcher → checker → final`, checks ten existing input/auth/ownership refusals, gracefully closes the owner, and reopens the same database. It checks all nine committed native tables and verifies that completed steps and budget charges were not repeated.

Expected output includes:

```text
PASS OFFLINE DEMO: native CLI/SQLite healthy reopen
```

Then a JSON object reports the run ID, status, final value and saved directory:

```json
{
  "runId": 7,
  "status": "succeeded",
  "result": {
    "kind": "final",
    "topic": "OFFLINE DEMO",
    "summary": "OFFLINE DEMO completed a deterministic handoff, not factual research.",
    "verified": true
  },
  "saved": "<repository>/.data/demo-<unique-id>"
}
```

`verified:true` means that the fixed demo contract passed. It does not mean that a model verified facts. Run IDs belong to individual stores; use the returned ID rather than assuming every store uses `7`.

Each invocation creates a new private directory under `.data/`. It retains:

- `jobs.sqlite`, the native execution state.
- `status.json` and `result.json`, readable saved outputs.
- `PASS.json`, `native-proof.json`, negative-case results and process logs.
- Two complete `logical-backup-*.json` captures made before native close.

The demo does not delete these artifacts. Stock SQLite opening, checkpointing and close may update the main database and automatically truncate/remove its own `jobs.sqlite-wal`, `jobs.sqlite-shm` or `jobs.sqlite-journal`. Do not point the demo at production data. To use a different parent, set `DURABLE_JOBS_DEMO_ROOT` to an existing private, owned, physical directory with mode `0700`.

A failure is not permission to retry a mutation or force-kill an owner. Preserve the output directory and diagnose the reported process. Failed or unproven native cleanup deliberately retains ownership.

## What the prototype does

- Runs registered agents sequentially, with bounded inputs, outputs, requests and deadlines.
- Validates terminal agent answers and each handoff before admitting the next step.
- Saves definition, inputs, implementation identities, receipts and budget accounting in native Durable state.
- Provides `start`, `status` and `cancel` through one authenticated local owner.
- Continues only unfinished work after a proven safe committed-step interruption.
- Blocks automatic replay when an unfinished effect is uncertain or a registered implementation no longer matches.

The public demo checks completed-work reopening. Controlled interruption, active cancellation and fail-closed reopening were also verified before extraction using the same unchanged core. Those historical checks used dedicated service/IPC workers; they are not claimed to be arbitrary crash tests or part of `npm test`. See [verification and limits](docs/verification.md).

## CLI and JSON definition

```sh
node bin/jobs.mjs help
node bin/owner.mjs help
```

The checked-in chain is:

```json
{
  "version": 1,
  "steps": [
    { "id": "research", "agent": "researcher" },
    { "id": "check", "agent": "checker" },
    { "id": "final", "agent": "final" }
  ]
}
```

For manual operation, provide a new canonical absolute `DURABLE_JOBS_STORE` path and a private shared `DURABLE_JOBS_SECRET` of at least 32 characters to both owner and CLI. The parent directory must exist. For optional pre-close capture, give the owner `DURABLE_JOBS_LOGICAL_BACKUP_DIR` equal to that private store directory.

```sh
# Terminal 1, with the store and secret configured:
node bin/owner.mjs examples/OFFLINE-DEMO.host.json

# Terminal 2, with the same store and secret, after startup.status is ready:
node bin/jobs.mjs start examples/research-check-final.json --input examples/OFFLINE-DEMO.input.json
node bin/jobs.mjs status 7  # replace with the returned run ID
node bin/jobs.mjs cancel 7
```

The owner stays in the foreground. A returned run ID does not create a daemon. SIGINT/SIGTERM requests graceful shutdown; wait for its actual exit before reopening the store. A cancel response of `marked` is an intent, not terminal settlement. Inspect `status.settled`, `nativeOutcome` and `reason`.

Definitions cannot select tools, cwd, providers, executable paths or ownership. Adding an agent requires trusted host code and explicit implementation/output-contract identities. The JSON is data, not executable configuration. Internal types and CLI implementation files retain their original `jobs` names.

## Scope and limitations

This is a sequential prototype, not a general DAG engine. It has no parallel branches, dynamic graphs, external-event bus, distributed workers, scheduler service, UI, automatic reconciliation or exactly-once external-effect guarantee.

Unknown effects become `needs_attention`; they are not silently replayed. An interrupted or cancelled request can retain an unresolved budget reservation. The prototype does not pretend that an uncertain charge is settled.

One participating process owns a canonical store path in one network namespace. This is not OS-wide locking against arbitrary SQLite clients. Operators must exclude path replacement, bind-mount aliases and nonparticipating database writers.

The OpenAI host configuration remains experimental. Live provider/model admission, real-model correctness, arbitrary crash recovery, a full adversarial filesystem audit and capture-failure quarantine have not been verified for this public prototype. No production, paid-provider or deployment claims are made.

## Roadmap and plans

The [roadmap](ROADMAP.md) separates the delivered sequential prototype from recommended next work and the wider deferred design. It includes dependencies and acceptance gates, not release dates or an automatically approved backlog.

- [Sequential MVP plan](docs/plans/sequential-mvp.md): the approved first-delivery contract and its accepted OFFLINE DEMO boundary.
- [Next iteration](docs/plans/next-iteration.md): publish portable controlled recovery/cancel/identity checks, then separately consider explicitly approved real-provider admission.
- [Workflow expansion](docs/plans/workflow-expansion.md): saved scenarios, worker reuse, parallel/dynamic graphs, approvals/events, actionable status, pause/retry, reusable blocks and optional adapters.

These are plans, not claims that the future features already exist. The original broader design remains deferred; the sequential core does not need rewriting to start the next slice.

## Related workflow authoring reference: pi-workflows

[osolmaz/pi-workflows](https://github.com/osolmaz/pi-workflows) (MIT) provides TypeScript workflow definitions, graph validation, routing and composition worth evaluating for this project's future graph support. The intended reuse is its workflow authoring logic **on native Pi Durable tasks**, not its separate server, runner, queue or SQLite state. This is a reference, not a dependency or an implemented integration; compatibility and recovery behavior still need verification.

## Development

`npm test` runs 65 existing fast admission, CLI and ownership checks. `npm run demo` performs the native offline smoke and completed-reopen check. Both use the official packages, not SDK source hooks.

A strict application `tsconfig.json` is included. Typechecking was verified with TypeScript 7.0.2 using `tsc --project tsconfig.json`. The compiler is not installed by this package; use an existing matching compiler if you want to repeat it. `skipLibCheck:true` checks the application, not all third-party declarations.

[Architecture](docs/architecture.md) · [Verification](docs/verification.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

**UNLICENSED.** A public repository is not an open-source license grant. No license has been selected for this project; see [LICENSE](LICENSE). Third-party dependencies retain their respective licenses. This repository is a source prototype and is not published as an npm package.
