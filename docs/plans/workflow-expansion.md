# Deferred workflow expansion plan

Status: future design backlog. This public adaptation preserves the wider revision-5 design after revision 6 narrowed the first delivery to sequential chains. These capabilities are not implemented merely because they appear here, and this document is not an instruction to execute the whole queue.

The original unit IDs are retained for traceability. Candidate module names describe possible future seams, not a required refactor of the current source tree.

## Product direction

The intended product lets a user select a saved scenario or propose a task-specific declarative draft, inspect its agents/order/effects/limits, and start a durable run. Status explains what is active, why it waits, who must act and which actions are allowed. A stage result is validated data and evidence, not a permission grant.

The wider design includes fixed sequences, predeclared conditions, bounded dynamic expansion and dynamically proposed definitions. Determinism means the committed definition, inputs, branch decisions and graph identities survive restart. It does not mean repeating model output or guaranteeing exactly-once effects in external systems.

## Existing baseline versus old prerequisites

The former U1 feasibility/contracts work and U2 sequential execution were reduced into the accepted sequential prototype. Their broader event, adapter and compatibility questions were not all completed. Do not recreate the initial scaffold, claim the entire old U1 checklist passed or make the delivered sequential CLI wait for a future catalog.

Further features should reuse native Durable tasks/conversations/checkpoints/documents, the current admission boundary, immutable receipts, guarded service and participating owner. There must not be a second scheduler, queue, execution journal or workflow-specific JavaScript runtime.

## U7: saved scenarios and a common declarative compiler

**Depends on:** baseline admission and immutable run snapshots. A sequential catalog can be delivered before graph features; graph compilation is accepted only with the corresponding execution checks.

**Approach:** add a read-only catalog root and versioned definitions with list/show/validate/explain operations. Normalize saved and ad-hoc definitions to one schema, then compile to stable native identities and typed input/output bindings. Reject unresolved actions, profiles, cycles, invalid references and capability injection before task creation. Keep active runs bound to their resolved snapshots.

The old design proposed bounded YAML normalization. For the first catalog slice, retain the existing JSON path and decide separately whether YAML is needed. If added, reject custom tags, aliases, duplicate keys and path/symlink escape; a parser dependency needs a concrete reason. Save must not silently overwrite an existing version.

**Acceptance:** equivalent saved/draft definitions resolve to the same normalized graph; invalid definitions have no effects; catalog traversal cannot access files outside its root; edits to source definitions or profiles do not change active runs; incompatible implementations block reopening.

## U9: one worker across sequential stages

**Depends on:** sequential baseline. This can be developed independently of parallel graph execution.

**Approach:** let a run own stable worker conversation identities. Several serial stages may submit to one worker without changing caller configuration. A worker belongs to the run, not a terminal stage. Preserve stable run/node/attempt request identities and commit a validated receipt before a successor submit.

**Acceptance:** three stages can use one worker conversation and retain three distinct receipts across restart; the caller's configuration stays unchanged; no duplicate worker or prompt is created between receipt and successor; unanswered/failed/cancelled work cannot admit a successor. Unordered parallel stages may not share one mutable worker conversation.

## U10: standard results, actionable status and notifications

**Depends on:** baseline; worker-reuse integration when U9 is enabled. Host delivery remains a separate adapter concern.

**Approach:** extend the receipt model with outcome, summary, declared outputs/artifact references, evidence and next action. Project current node, remaining work, waiting/failure reason, responsible actor, deadline and allowed actions without asking a model to reconstruct state. Use committed transition records and deduplication for host notifications; notifications are projections, not continuation authority.

**Acceptance:** missing/invalid outputs or unavailable artifacts block dependents with a specific reason; status and artifact access remain owner-scoped; duplicate or failed delivery cannot create another workflow or lose the saved result. Retention must preserve committed run data. Display delivery is not model input or a control wakeup.

## U3: parallel branches and joins

**Depends on:** sequential baseline and stable owned branch identities.

**Approach:** start independent read-only B/C/D tasks after A. Allow F after successful D while B/C remain active, if capacity is available. Let final E wait for exactly its required valid outputs. Define fail-fast versus collect-errors explicitly; the original default is fail-fast. Do not introduce concurrent writers until an explicit workspace/capability policy is proven.

**Acceptance:** a barrier proves actual overlap; D completion admits F without waiting for unrelated branches; E does not start early; D failure cannot start F; skipped nodes do not create impossible joins. Restart between D receipt and F dispatch retains one F identity. Cancellation leaves no orphan work and concurrency/request/output limits remain enforced.

## U4: conditional branches and bounded dynamic expansion

**Depends on:** U3.

**Approach:** derive a bounded node set from validated structured output. Persist the branch decision, expanded node identities and dependencies before child dispatch. Reject cycles, duplicate IDs, unknown profiles and forbidden capabilities. Fixed presets and dynamic instances use the same compiler/admission/native execution path.

The archived design suggested initial ceilings of 20 nodes and concurrency 3. These are proposed future limits, not claims about today's configuration. Its suggested retry ceiling is not permission to replay unknown effects; retries require the eligibility policy in U11.

**Acceptance:** zero, two and three discovered parts have explicit behavior; malformed or oversized expansion has no effects; restart retains the same expanded graph; agent output containing permission-like text does not grant authority. Do not add recursive runtime loops or arbitrary generated JavaScript.

## U5: human approval and one durable external event

**Depends on:** successful persistent inbox/wakeup feasibility proof. Sequential gates do not require all graph work; parallel integration needs U3.

**Approach:** start with human approval and a normalized test event, not a public webhook platform. Correlate actor, run, wait identity and exact effect digest. Persist the event and consume it atomically with continuation admission. Denial, timeout and cancellation have explicit outcomes. Keep bounded payloads and retention rules, with no secrets in status.

**Acceptance:** an event arriving before or after wait registration survives restart without lost wakeup; duplicate IDs do not admit a second continuation; wrong actor/run/wait, stale approval and changed effect digest are rejected. Test restart on each consumption/continuation boundary. This is deduplicated backend admission, not exactly-once delivery to arbitrary external systems.

## U11: pause, resume and targeted retry

**Depends on:** U3, U9, U10 and a proven persistent control inbox/wakeup path from U5 feasibility work.

**Approach:** persist a dispatch barrier. `pause_requested` stops new admissions; `paused` is reported only when the defined in-flight work has settled. Resume rechecks current policy and preserves the original definition snapshot. An eligible retry creates a new attempt in the same run, not a replacement of successful receipts.

**Acceptance:** a pause racing branch completion cannot admit work past the committed barrier; in-flight receipts remain; a later owner can inspect/resume the same IDs without a model call to reconstruct history. Events received while paused remain durable but do not dispatch successors. Unknown effects, revoked permissions or missing artifacts block retry/resume. Successful siblings and consumed outputs are not hidden by new attempts.

## U8: task-specific workflow drafts and action parity

**Depends on:** U3, U4, U7 and U9. Drafts containing executable gates need accepted U5 behavior.

**Approach:** accept user-authored or model-proposed declarative data through the same schema as saved scenarios. Explain workers, order, effects and limits before admission. Separate validate, explain, start and explicit save. Bind admission to an immutable digest and recheck policy at start; validation is not authorization. Host API, native tools and codemode must call the same authorized handlers.

**Acceptance:** equivalent saved/ad-hoc workflows use one execution path; oversized/cyclic/hidden-write/unknown-worker drafts fail before dispatch. Mutation or revocation between explanation and start cannot reuse a stale grant. Duplicate start intent cannot create a second run. Start does not silently write the catalog, and save cannot overwrite another scenario.

## U12: reusable typed blocks

**Depends on:** U4, U7, U9 and U10. The compiler can be developed before U11; acceptance of pause/retry inside composed workflows needs U11.

**Approach:** define versioned blocks with typed input/output ports. Resolve and snapshot block versions, namespace expanded node/worker identities and retain a source map for status. Expand into the existing native execution path, not a nested-workflow scheduler.

**Acceptance:** two uses of the same block have separate identities and correct bindings; equivalent saved and ad-hoc composition normalizes consistently; recursive includes, cycles, unknown versions, expanded-size overflow and permission escalation fail before effects. Library edits do not change a running snapshot. Status and control refer to the correct block source path.

## U6: optional Pocket adapter and bounded pilot

**Depends on:** baseline and acceptance gates for each capability actually enabled. It does not require shipping every future capability.

**Approach:** keep host imports and context/policy resolution in a separate adapter. Install/enable only by explicit operator choice. Preserve host tool guards, requester identity, limits, workspace reservations, notifications and wakeup policy. The core still imports and runs without Pocket. Do not copy unrelated transcripts or secrets into child context.

**Acceptance:** read-only agents cannot write or shell around host guards; a writer requires an authorized capability and lease or isolated workspace; API/tool actions authorize identically; denied effects do not execute. Begin in an isolated host, then only an explicitly approved bounded pilot. No automatic activation, data cleanup or changes to a working Pocket installation are implied.

## U13: optional Beads/Dolt bridge

**Depends on:** U8, U10, U11 and U12. External gates also require U5. Standalone delivery never depends on this bridge.

**Approach:** verify the pinned public tracker CLI/schema in isolation before integration. Start with explicit dispatch of one eligible task. Persist claim/start/link correlation and a result outbox with reconciliation for interrupted boundaries. Only an authorized coordinator writes tracker state. Dependency-chain dispatch and any formula subset import are later opt-in features, not prerequisites for a simple task.

**Acceptance:** core works without the tracker; repeated dispatch of the same task revision cannot create duplicate runs; scope/assignee changes or manual closure cannot be overwritten by stale projections. Unknown methods/formula semantics block rather than guess. Runtime success does not mean business acceptance or automatic task closure. Agents cannot resolve human gates or gain tracker-write authority from result data.

## Cross-cutting contracts

- A handoff keeps task identity and passes only declared, validated values or scoped artifact references. It does not copy every transcript.
- Ownership, limits and effect permissions apply at dispatch and again where recovery requires them. Results and explanation text do not grant permissions.
- Persisted decisions and receipts, not model recollection, determine continuation. Unknown effects need idempotency/reconciliation or `needs_attention`.
- A plugin, tool interface or codemode entry cannot bypass common admission. A host adapter is not a competing scheduler.
- Preserve primary databases, committed results, backups and logs. Native lifecycle checks require the actual environment's authorization; this document grants none.

## Suggested execution order

Start with [public lifecycle reproducibility](next-iteration.md). Then select a small U7 catalog, U9 worker-reuse or U10 status slice. Add U3 before U4. Prove U5 inbox/wakeup behavior before exposing gates or general recovery controls. Enable U8/U12 composition only after their dependencies are accepted. Adapters stay optional and independently gated.

This is a recommendation, not a newly approved schedule. Do not dispatch all U1–U13 units, add an independent-QA requirement by copying old historical text, or rebuild the accepted core without a reproduced need. Select affected behavioral checks for each slice and record real acceptance evidence.
