import { Harness, LiveDoc, ProviderDoc, createRegistry, defineExtension, type ConversationId, type Storage, type TaskId } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import { withoutAbortSignal } from '@earendil-works/chord/context';
import { admitDefinition, type AdmissionPolicy } from './admission.ts';
import { getOwnedRun, cancelOwnedRun } from './access.ts';
import { BudgetDoc, createBudgetModels, initializeRootBudget, inspectRootBudget, associateChild,
  type BudgetModelsOptions } from './budget.ts';
import { createJobsPreflight, type StartupResult } from './startup.ts';
import { createRunTask, createStageTask } from './runtime.ts';
import type { JobsClient, JsonValue } from './cli.ts';

export type JobsServiceOptions = {
  storage: Storage;
  policy: AdmissionPolicy;
  budget: Omit<BudgetModelsOptions, 'now'>;
  now?: () => number;
  onReport?: (error: unknown) => void;
};
export type JobsService = {
  readonly client: Readonly<JobsClient>;
  readonly startup: StartupResult;
  close(): Promise<void>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** One exclusive foreground owner. Storage MUST NOT be opened by another Harness, even paused.
 * The host authenticates possession of this client; no owner/runtime/provider field comes from Jobs JSON.
 * Keep this service alive until explicit close. It is neither an IPC server nor a daemon. */
export async function openJobsService(options: JobsServiceOptions, context: Context): Promise<JobsService> {
  const now = options.now ?? Date.now;
  const cleanupContext = withoutAbortSignal(context);
  const perRequestOutputTokens = options.budget.perRequestOutputTokens;
  const policy: AdmissionPolicy = {
    limits: Object.freeze({ ...options.policy.limits }),
    allowedAgents: Object.freeze([...options.policy.allowedAgents]),
    agents: Object.freeze(options.policy.agents.map(({ output, ...snapshot }) => Object.freeze({
      ...structuredClone(snapshot), output: Object.freeze({
        validate: output.validate.bind(output), succeeded: output.succeeded.bind(output),
      }),
    }))),
  };
  // B currently admits one fixed model. Reject mismatches before opening storage or creating tasks.
  if (policy.agents.some(agent => agent.model.provider !== options.budget.model.provider ||
      agent.model.modelId !== options.budget.model.id)) throw new Error('Unsupported Jobs model');
  const budget = createBudgetModels({ ...options.budget, perRequestOutputTokens, now });
  const Stage = createStageTask(policy.agents, associateChild);
  const Run = createRunTask(Stage);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'durable-jobs', tasks: [Run, Stage] }));
  const harness = await Harness.open(options.storage, { registry, models: budget.models, now,
    settings: { retry: { enabled: false }, compaction: { enabled: false }, stream: { maxRetries: 0 } },
    onReport: options.onReport }, context);
  try {
    await budget.bindHarness(harness);
    // Native reserved root is the trusted owner, never a caller-supplied number or user JSON field.
    const owner = await harness.root(context);
    const preflight = createJobsPreflight({ agents: policy.agents, ownerConversationIds: [owner.id],
      registry, models: budget.models });
    let startup = await preflight(harness, context);
    if (startup.status === 'ready') {
      for (const id of startup.runIds) {
        const run = await getOwnedRun(harness, owner.id, id, context);
        if (run.state.status === 'terminal') continue;
        const inspection = await inspectRootBudget(harness, id, now(), context);
        if (!inspection.ok) {
          startup = { status: 'needs_attention', reason: `budget_${inspection.reason}` }; break;
        }
      }
    }
    // No progress API is invoked on a blocked startup. Status and marked cancellation remain available.
    if (startup.status === 'ready') harness.resume();
    const sealedStartup = Object.freeze(structuredClone(startup));
    let lifecycle: 'open' | 'closing' | 'closed' = 'open';
    let closePromise: Promise<void> | undefined;
    let tail = Promise.resolve();
    function exclusive<T>(operation: () => Promise<T>): Promise<T> {
      if (lifecycle !== 'open') return Promise.reject(new Error(`Jobs service ${lifecycle}`));
      const result = tail.then(operation);
      tail = result.then(() => {}, () => {});
      return result;
    }
    async function status(runId: number): Promise<JsonValue> {
      const run = await getOwnedRun(harness, owner.id, runId as TaskId, context);
      const input = run.input;
      if (!object(input) || !Array.isArray(input.steps) || input.steps.length > 64 || !positive(input.deadline)) {
        return { runId, lifecycle: 'needs_attention', reason: 'invalid_run', accepted: [] };
      }
      const state = run.state;
      const result = state.status === 'terminal' ? state.outcome.result : state.checkpoint;
      const refs = object(result) ? result.stages : undefined;
      const accepted: JsonValue[] = [];
      let invalid = !Array.isArray(refs) || refs.length > input.steps.length;
      if (!invalid && Array.isArray(refs)) {
        const seen = new Set<number>();
        for (const [index, id] of refs.entries()) {
          if (!positive(id) || seen.has(id)) { invalid = true; break; }
          seen.add(id);
          const stage = await harness.getTask(id as TaskId, context);
          const step = input.steps[index];
          const receipt = stage?.state.status === 'terminal' && stage.state.outcome.status === 'completed'
            ? stage.state.outcome.result : undefined;
          if (!stage || stage.owner !== run.id || stage.kind !== 'jobs.stage' || stage.conversationId !== owner.id ||
              !object(step) || !object(step.agent) || !object(receipt) || receipt.ok !== true ||
              receipt.runId !== run.id || receipt.stageTaskId !== id || receipt.agent !== step.agent.name ||
              receipt.outputContractId !== step.agent.outputContractId || typeof step.id !== 'string') {
            invalid = true; break;
          }
          // Native receipts are JSON, never raw Error, provider credentials or transcript projections.
          accepted.push({ stepId: step.id, stageTaskId: id, value: receipt.value as JsonValue });
        }
      }
      let lifecycle = state.status === 'terminal' ? state.outcome.status === 'completed' ? 'succeeded' :
        state.outcome.status === 'aborted' ? 'cancelled' : 'failed' : run.abortRequested ? 'cancel_requested' :
        state.status === 'pending' ? 'queued' : 'running';
      let reason: string | null = null;
      if (state.status === 'terminal' && state.outcome.status === 'failed') {
        const detail = state.outcome.error?.detail;
        if (object(detail) && typeof detail.code === 'string' &&
            ['needs_attention', 'deadline', 'stage_failed'].includes(detail.code)) reason = detail.code;
      }
      const ledger = await harness.snapshot(BudgetDoc, context);
      const stored = object(ledger) && object(ledger.runs) ? ledger.runs[String(run.id)] : undefined;
      const reservations = object(stored) ? stored.reservations : undefined;
      const invalidBudget = !Array.isArray(reservations) || reservations.some(item => !object(item) ||
        !['reserved', 'settled'].includes(String(item.status)));
      const reserved = Array.isArray(reservations) ? reservations.filter(item => object(item) && item.status === 'reserved') : [];
      const unresolved = reserved.length > 0 && !(reserved.length === 1 && await knownLiveReservation(reserved[0]));
      if (invalid || invalidBudget || unresolved || reason === 'needs_attention' || sealedStartup.status !== 'ready') {
        lifecycle = 'needs_attention';
        reason = invalid ? 'invalid_receipt' : invalidBudget ? 'budget_uninspectable' : unresolved ? 'unresolved_reservation' :
          sealedStartup.status === 'needs_attention' ? sealedStartup.reason : reason;
      }
      const current = input.steps[accepted.length];
      return JSON.parse(JSON.stringify({ runId, lifecycle, reason, nativeStatus: state.status,
        nativeOutcome: state.status === 'terminal' ? state.outcome.status : null,
        cancelRequested: run.abortRequested, settled: state.status === 'terminal', deadline: input.deadline,
        currentStep: object(current) && typeof current.id === 'string' ? current.id : null, accepted }));

      async function knownLiveReservation(reservation: unknown): Promise<boolean> {
        // Ready startup proves there were no unresolved charges on open. Only a currently correlated native
        // request in this owning Harness can account for a later reserved charge; this never authorizes replay.
        if (sealedStartup.status !== 'ready' || invalidBudget || state.status === 'terminal' || run.abortRequested ||
            !object(state.checkpoint) || state.checkpoint.phase !== 'collect' || !object(reservation) ||
            typeof reservation.key !== 'string' || (await harness.inspect(context)).scheduling !== 'running') return false;
        let key: unknown;
        try { key = JSON.parse(reservation.key); } catch { return false; }
        if (!Array.isArray(key) || key.length !== 7 || !key.every(positive) || key[0] !== run.id ||
            key[2] !== state.checkpoint.current || key[5] !== 1) return false;
        const [, childId, stageId, submissionId, generationId, attempt, cutoff] = key;
        const stage = await harness.getTask(stageId as TaskId, context);
        const generation = await harness.getTask(generationId as TaskId, context);
        const child = childId as ConversationId;
        const live = await harness.snapshot(LiveDoc, child, context);
        const provider = await harness.snapshot(ProviderDoc, child, context);
        const link = object(ledger) && object(ledger.sessions) && provider ? ledger.sessions[provider.sessionId] : undefined;
        if (!stage || stage.owner !== run.id || stage.conversationId !== owner.id || stage.kind !== 'jobs.stage' ||
            stage.state.status !== 'running' || stage.abortRequested || !object(stage.state.checkpoint) ||
            stage.state.checkpoint.phase !== 'answer' || stage.state.checkpoint.child !== childId ||
            !generation || generation.kind !== 'pi.generation' || generation.conversationId !== childId ||
            generation.state.status !== 'running' || generation.abortRequested || !object(generation.state.checkpoint) ||
            generation.state.checkpoint.phase !== 'request' || generation.state.checkpoint.attempt !== attempt ||
            generation.state.checkpoint.cutoff !== cutoff || live?.run?.taskId !== generationId ||
            live.run.inputs.length !== 1 || live.run.inputs[0] !== submissionId || live.generation?.attempt !== attempt ||
            !object(link) || link.runId !== run.id || link.childId !== childId || link.stageId !== stageId ||
            link.requestId !== `jobs-stage:${stageId}`) return false;
        return harness.commit(async tx => {
          const record = await tx.conversation(child);
          const submission = await tx.submissionByRequest(child, `jobs-stage:${stageId}`);
          return record?.owner?.conversationId === owner.id && record.owner.taskId === stageId &&
            submission?.id === submissionId && submission.type === 'input' && submission.status === 'placed';
        }, context);
      }
    }
    const client: Readonly<JobsClient> = Object.freeze({
      start: (definitionJson: string, inputJson: string) => exclusive(async () => {
        // Admission is always real, including on a blocked service, and never creates tasks on rejection.
        const admitted = admitDefinition(definitionJson, inputJson, policy, now());
        if (sealedStartup.status !== 'ready') throw new Error('Jobs startup needs attention');
        const exactInput = Object.freeze({ ...admitted.run, budget: Object.freeze({
          maxRequests: admitted.limits.maxRequests, maxOutputTokens: admitted.limits.maxOutputTokens,
          deadline: admitted.run.deadline,
        }), budgetPerRequestOutputTokens: perRequestOutputTokens });
        const runId = await harness.commit(async tx => {
          const id = await tx.createTask(Run, exactInput, { ownership: { kind: 'conversation' },
            conversationId: owner.id, background: true });
          await initializeRootBudget(tx, id, exactInput, exactInput.budget);
          return id;
        }, context);
        return { runId };
      }),
      status: (runId: number) => exclusive(() => status(runId)),
      cancel: (runId: number) => exclusive(async () => {
        const cancellation = await cancelOwnedRun(harness, owner.id, runId as TaskId, context);
        return { cancellation, status: await status(runId) };
      }),
    });
    return Object.freeze({ client, startup: sealedStartup, close: () => {
      if (!closePromise) {
        lifecycle = 'closing';
        closePromise = tail.then(() => harness.close(cleanupContext)).then(() => { lifecycle = 'closed'; });
      }
      return closePromise;
    } });
  } catch (error) {
    try { await harness.close(cleanupContext); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Jobs initialization and cleanup failed'); }
    throw error;
  }
}
