# Verification and limits

This project is an extracted working prototype, not a production release. The public repository contains the unchanged accepted execution core and portable examples. Its verification claims distinguish public reproducible checks from earlier controlled lifecycle tests.

## Public reproducible checks

Verified on Linux, Node 24.19.0, npm and the official SDK 1.2.0 packages. A fresh `npm ci --ignore-scripts` installed the same 91 locked packages without SDK builds or source loaders.

| Scenario | Result | Repeat with |
|---|---|---|
| Existing admission, CLI and owner checks | 65 PASS, zero fail/cancel/skip | `npm test` |
| Real owner and separate CLI processes execute A→B→C with validated results | PASS | `npm run demo` |
| Native SQLite preserves results across graceful close/reopen | PASS | `npm run demo` |
| All nine committed tables, receipts and budget accounting unchanged on completed reopen | PASS | Inspect the demo's `PASS.json`, `native-proof.json` and two full captures |
| Ten existing malformed-input, authorization and duplicate-owner refusals | PASS | Inspect `negative-cases.json` from `npm run demo` |
| Strict application noEmit typecheck | PASS, TypeScript 7.0.2 | `tsc --project tsconfig.json` with a separately available compiler |

The demo prints its unique retained directory. It contains `status.json`, `result.json`, process logs, the database and pre-close captures. Nothing is automatically deleted. A successful run had three native stage tasks, three generations and three settled request reservations. Output accounting charges the reserved caps; it is not a claim about real-model token usage.

`npm test` is a bounded fast suite, not the whole historical verification corpus. The CLI tests include injected clients and are not native SQLite evidence. The demo separately exercises the real executable/native path.

## Historical controlled lifecycle checks

The following scenarios passed on the same unchanged core with official SDK packages before extraction. They used dedicated real service/IPC workers to request an orderly stop at a committed boundary or hold a deterministic B response. These internal fixtures and their private databases/logs are not tracked or published in this repository. A maintainer checkout may retain copies in an ignored local archive. The table is a recorded result rather than a new public test receipt.

| Scenario | Recorded result |
|---|---|
| Stop after confirmed A, then reopen in a new process | First process calls A; second calls only B/C. A records, receipt and first budget debit remain unchanged. |
| CLI cancel while B is genuinely active | Native abort occurs before owner close, C is not created, and restart makes zero new calls. |
| Uncertain B effect at owner stop | Startup blocks with `unsafe_unfinished_generation`; status reports `unresolved_reservation`; zero new calls. |
| Trusted implementation identity mismatch | Startup/status report `agent_identity_changed`; zero new calls. |
| Retention | Main databases, full pre-close logical captures, outputs and logs remain; worker exits and output streams were joined. |

Cancelled B retains its unresolved reservation. It is not silently marked settled. Native startup can reset running records to pending and advance its sequence while keeping committed receipts/accounting intact; unchanged database byte hashes are not a valid general restart oracle.

Healthy completed-work reopening is not interrupted recovery. The A-boundary interruption was a controlled graceful stop, not an arbitrary crash. The public owner executable has no hidden test gates added for these scenarios.

## Not verified

- Live provider/model admission or successful real-model calls.
- Factual correctness of agent-generated research.
- Arbitrary process crashes, host failures or exactly-once external effects.
- A full adversarial native filesystem matrix, capture-failure quarantine or independent lifecycle-boundary audit.
- Windows behavior, distributed workers or nonparticipating SQLite clients.
- An installed/published npm distribution of this project.

No new independent QA receipt is claimed. Production data, Pocket, global runtime settings and SDK implementation files were not changed during extraction.
