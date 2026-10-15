# Next iteration

Status: recommended work, not started. This plan closes the public reproducibility gap before adding more workflow features. It does not authorize implementation, a live provider call, production changes or destructive tests.

## Goal

A fresh public checkout can reproduce the controlled continuation, cancellation and blocked-reopen checks already recorded in [verification](../verification.md). The public claims should not depend on inaccessible local fixtures.

The existing sequential core remains the baseline. Do not refactor it unless a concrete defect is reproduced. Keep real-model admission separate from offline lifecycle work.

## Slice 1: publish controlled A-boundary continuation

**Start from:** the existing internal controller that observes a successful commit of terminal A, requests a graceful owner close, joins the first process, and reopens the same retained store in a new process.

**Work:** adapt paths, source binding and invocation to the public checkout. Use ordinary official SDK imports. Reuse the actual service, budget, IPC and native capture code. Keep any commit observer in test-only code, never in job JSON or production owner configuration.

**Likely files:** a portable lifecycle test/controller under `test/` or `scripts/`, a package script and updates to `docs/verification.md`. The existing `src/jobs.ts`, `src/runtime.ts`, `src/budget.ts`, `src/startup.ts` and `src/native-capture.ts` should be unchanged unless the check finds a reproduced defect.

**Done when:**

- First process records only A; second process records only B/C for the same run.
- A task/generation/conversation/submission/answer records and receipt retain their identities and contents.
- Definition snapshot, seed input, deadline and A's first settled reservation are preserved.
- Total requests are three, not a repeated charge for A. All accepted handoffs are validated.
- Each successful close has a retained complete pre-close capture. Main database, outputs, logs and captures remain after observed process exit and reopen.

This is orderly controlled interruption. Keep arbitrary crash recovery explicitly unverified.

## Slice 2: publish active cancellation and unsafe-reopen regressions

**Depends on:** Slice 1's portable lifecycle entry and retained-artifact handling.

**Start from:** the existing held-B cancellation controller and the corrected negative controller. Do not create a second testing framework.

**Work:** expose separately selectable scenarios for active cancel, uncertain B and trusted implementation identity mismatch. Hold a public Faux response until genuine native abort. Use actual CLI calls for cancellation. Keep implementation mutation confined to trusted test registry setup.

**Done when:**

| Scenario | Expected observation |
|---|---|
| CLI cancel active B | Cancel is marked separately from settlement, native B abort is observed, C is never created |
| Reopen cancelled work | No new provider calls; A remains settled, B's unresolved reservation remains visible |
| Stop with uncertain B | No cancel is invented; reopened startup blocks with `unsafe_unfinished_generation`, status reports `unresolved_reservation`, zero new calls |
| Incompatible registered implementation | `agent_identity_changed`, zero new calls, no replacement of the original snapshot |

For blocked reopen, allow only the exact pinned SDK housekeeping already established by the existing oracle: running-to-pending resets and the corresponding sequence change. Compare the complete committed schema/tables against that baseline-derived expectation. Do not replace the oracle with an unchanged database byte hash or an overly broad ignore list.

## Slice 3: document and verify the public entry

Add one documented command with selectable scenarios or a small set of package scripts. Do not silently turn `npm test` into an uncontrolled native, live-provider or long-running matrix.

Run only affected fast tests after a change. Before handoff, run one necessary final lifecycle pass, the existing fast checks and application typecheck. Bind results to the final code and SDK tuple with a small relevant manifest, not a fresh inventory of every unchanged dependency file.

Update `README.md`, `ROADMAP.md` and `docs/verification.md` to replace historical-only statements only for scenarios actually reproduced from the public checkout. Record unavailable checks honestly. A timeout triggers process diagnosis, not another concurrent owner or a force-kill into a PASS.

## Optional real-provider admission

This is a separate opt-in slice. The existing OpenAI configuration is experimental and has not established live compatibility. Offline lifecycle work can proceed without this slice.

1. Inspect the actual public provider/model catalog and SDK contract. Confirm endpoint, supported options, output-cap minimums, authentication and cancellation semantics before network execution.
2. Choose one provider/model, explicit host configuration, maximum request/output/spend limits and a private credential mechanism. Get the owner's approval for live spending and the exact bounded run.
3. Keep explicit provider selection. Missing credentials or rejected configuration must fail, never fall back to Faux.
4. Run the smallest approved sequential example. Verify validated handoffs, cancellation behavior, budget reservations and saved results. Do not retry a potentially committed request merely because its reply or output was lost.
5. Publish only sanitized results. Record successful compatibility separately from factual quality. One successful chain does not prove arbitrary research accuracy or exactly-once external effects.

The existing single-request/capped-provider guard must remain intact. Reserved output accounting and actual billed usage are different quantities and must be labeled accordingly.

## Decisions outside this iteration

- License selection and any npm publication remain owner decisions. Public visibility alone does not provide a license grant.
- Arbitrary crash recovery requires its own stated failure model and explicit failure-injection/lifecycle permissions. No signal or destructive test is authorized here.
- Production filesystem hardening, capture-failure quarantine and a complete security/lifecycle audit need a separately bounded scope. Do not add soak, fuzz, benchmark or review panels merely to expand this iteration.
- Parallel graphs, gates, adapters and generalized retries stay in the [expansion plan](workflow-expansion.md).

## Safety and acceptance

Use fresh isolated stores and known owned processes. Apply the test environment's actual permissions for native checkpoint/sidecar cleanup; this plan is not a transferable cleanup exception. Preserve main databases, outputs, backups and logs. Never patch SDK internals, remove ownership/validation/budget guards, add a permissive replay fallback or open a competing database connection to make a scenario pass.
