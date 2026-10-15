# Architecture

```text
JSON definition + input
          |
    CLI start/status/cancel
          |
 authenticated loopback IPC
          |
 one foreground SQLite owner
          |
 admission + budget + restart preflight
          |
 native Durable run task
          |
 A terminal receipt -> B terminal receipt -> C terminal receipt
```

Pi Durable is the only scheduler and source of durable execution state. This project does not implement a second queue, journal, workflow scheduler or generated-code executor.

## Module map

| File | Responsibility |
|---|---|
| `src/admission.ts` | Bounded JSON parsing, registered-agent admission and immutable input snapshots |
| `src/runtime.ts` | Native run/stage tasks and sequential dispatch/collect |
| `src/agent-result.ts` | Terminal answer identity, result schema and domain success validation |
| `src/budget.ts` | Request reservations, output caps and persisted accounting guards |
| `src/access.ts` | Run ownership checks and cancellation |
| `src/startup.ts` | Native restart preflight and implementation identity checks |
| `src/jobs.ts` | Common service, admission and startup-gate composition |
| `src/ipc.ts` | Bounded authenticated local transport, acquired before SQLite opens |
| `src/host.ts` | Trusted host/provider setup and registered example agents |
| `src/native-capture.ts` | Optional complete same-connection logical capture before stock close |
| `src/cli.ts` | Thin argument parsing and sanitized CLI results |
| `bin/owner.mjs` | Foreground owner lifecycle |
| `bin/jobs.mjs` | CLI client; never opens SQLite |

## Ownership and shutdown

The owner acquires its loopback endpoint before opening storage. A second participating owner fails rather than selecting a different port. Clients never open a second Harness or database connection.

Shutdown seals new work and waits for admitted operations and native cleanup. Optional capture uses the same connection and retains the complete schema and nine committed tables before stock close. A rejected or unresolved close does not release ownership or claim success.

Logical captures are non-authoritative evidence, not a second execution store or a supported restore format. Normal SQLite checkpoints can change database pages while preserving committed logical state.

## Restart decisions

A run records its definition, seed input, deadline, budget and required implementation identities at start. Successful stage receipts are immutable handoff authority. Later JSON edits cannot change that run.

Reopening first requires exclusive ownership, native preflight and budget inspection. A known-safe checkpoint can continue unfinished stages without repeating the completed prefix. Unknown unfinished effects or incompatible implementations block model execution and produce `needs_attention`.

Cancellation marks the owned native task subtree. The client response is not a promise that all effects have settled. Unresolved reservations remain visible across restart; no automatic replay or charge-forgiveness is added to make the status look successful.

## Demo trust boundary

The offline host explicitly selects public SDK Faux and fixed deterministic outputs. Missing real-provider configuration never silently falls back to Faux. The demo follows the same service, budget, validation, IPC and native storage path, but cannot establish real-model behavior or factual correctness.
