import { AssistantEntry, defineDoc, LiveDoc, ProviderDoc, type ConversationId, type EntryId, type Harness, type TaskId, type Tx } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context';
import type { RunInput } from './runtime.ts';
import { createModels, createAssistantMessageEventStream, type Api, type AssistantMessage, type Model,
  type Models, type ModelsSimpleStreamOptions, type Provider } from '@earendil-works/pi-ai';

export type BudgetLimits = { maxRequests: number; maxOutputTokens: number; deadline: number };
type Reservation = { key: string; tokens: number; status: 'reserved' | 'settled' };
type RunBudget = { snapshot: string; limits: BudgetLimits; requests: number; outputTokens: number; reservations: Reservation[] };
type Association = { runId: number; childId: number; stageId: number; requestId: string };
export type BudgetState = { runs: Record<string, RunBudget>; sessions: Record<string, Association> };

// Session scope retains charges after native task settlement. No LiveDoc writes or auxiliary journal.
export const BudgetDoc = defineDoc<BudgetState>({ kind: 'jobs.budget', version: 1, scope: 'session',
  initial: () => ({ runs: {}, sessions: {} }), checkpointWhen: () => true });

function deny(reason: string): never { throw new Error(`Jobs budget denied: ${reason}`); }
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deny('invalid native record');
  return value as Record<string, unknown>;
};

type AnchoredInput = RunInput & { budget: BudgetLimits; budgetPerRequestOutputTokens: number };
type NativeTask = NonNullable<Awaited<ReturnType<Tx['task']>>>;
function malformed(): never { deny('malformed budget'); }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) malformed();
  return value as Record<string, unknown>;
}
function sameLimits(a: BudgetLimits, b: BudgetLimits): boolean {
  return a.maxRequests === b.maxRequests && a.maxOutputTokens === b.maxOutputTokens && a.deadline === b.deadline;
}
function validLimits(limits: BudgetLimits): void {
  exact(limits, ['maxRequests', 'maxOutputTokens', 'deadline']);
  if (!positive(limits.maxRequests) || !positive(limits.maxOutputTokens) || !positive(limits.deadline)) malformed();
}
function checkLimits(limits: BudgetLimits): void {
  if (!limits || !positive(limits.maxRequests) || !positive(limits.maxOutputTokens) || !positive(limits.deadline)) deny('invalid limits');
  exact(limits, ['maxRequests', 'maxOutputTokens', 'deadline']);
}
function attemptKey(key: string): number[] {
  let value: unknown;
  try { value = JSON.parse(key); } catch { malformed(); }
  if (!Array.isArray(value) || value.length !== 7 || !value.every(positive) || value[5] !== 1 || JSON.stringify(value) !== key) malformed();
  return value;
}
function validateLedger(ledger: BudgetState, cap?: number): void {
  exact(ledger, ['runs', 'sessions']);
  record(ledger.runs); record(ledger.sessions);
  for (const [id, budget] of Object.entries(ledger.runs)) {
    if (!positive(Number(id)) || String(Number(id)) !== id) malformed();
    exact(budget, ['snapshot', 'limits', 'requests', 'outputTokens', 'reservations']);
    validLimits(budget.limits);
    if (typeof budget.snapshot !== 'string' || !Number.isSafeInteger(budget.requests) || budget.requests < 0 ||
        !Number.isSafeInteger(budget.outputTokens) || budget.outputTokens < 0 || !Array.isArray(budget.reservations) ||
        budget.requests !== budget.reservations.length || budget.requests > budget.limits.maxRequests || budget.outputTokens > budget.limits.maxOutputTokens) malformed();
    let snapshot: AnchoredInput;
    try { snapshot = JSON.parse(budget.snapshot); } catch { malformed(); }
    if (!snapshot || typeof snapshot !== 'object' || snapshot.deadline !== budget.limits.deadline ||
        !positive(snapshot.budgetPerRequestOutputTokens)) malformed();
    validLimits(snapshot.budget);
    if (!sameLimits(snapshot.budget, budget.limits) || (cap !== undefined && snapshot.budgetPerRequestOutputTokens !== cap)) malformed();
    const keys = new Set<string>(); const generations = new Set<number>(); const submissions = new Set<number>();
    let tokens = 0;
    let previousGeneration = 0;
    for (const item of budget.reservations) {
      exact(item, ['key', 'tokens', 'status']);
      if (typeof item.key !== 'string' || !positive(item.tokens) || item.tokens > budget.limits.maxOutputTokens ||
          (cap !== undefined && item.tokens > cap) || !['reserved', 'settled'].includes(item.status)) malformed();
      const key = attemptKey(item.key);
      if (key[0] !== Number(id) || keys.has(item.key) || generations.has(key[4]) || submissions.has(key[3]) || key[4] <= previousGeneration ||
          item.tokens !== Math.min(snapshot.budgetPerRequestOutputTokens, budget.limits.maxOutputTokens - tokens)) malformed();
      previousGeneration = key[4];
      keys.add(item.key); generations.add(key[4]); submissions.add(key[3]); tokens += item.tokens;
      if (!Number.isSafeInteger(tokens)) malformed();
    }
    if (tokens !== budget.outputTokens) malformed();
  }
  const children = new Set<number>(); const stages = new Set<number>();
  for (const [session, link] of Object.entries(ledger.sessions)) {
    exact(link, ['runId', 'childId', 'stageId', 'requestId']);
    if (!session || !positive(link.runId) || !positive(link.childId) || !positive(link.stageId) ||
        !Object.hasOwn(ledger.runs, String(link.runId)) || link.requestId !== `jobs-stage:${link.stageId}` ||
        children.has(link.childId) || stages.has(link.stageId)) malformed();
    children.add(link.childId); stages.add(link.stageId);
  }
}
async function validateNativeBudget(tx: Tx, ledger: BudgetState, runId: TaskId, cap?: number) {
  validateLedger(ledger, cap);
  const budget = ledger.runs[String(runId)];
  const root = await tx.task(runId);
  if (!budget || !root || root.kind !== 'jobs.run' || root.version !== 1 || root.owner !== undefined || root.background !== true) malformed();
  const input = root.input as AnchoredInput;
  if (!input || typeof input !== 'object' || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 64 ||
      input.deadline !== budget.limits.deadline || JSON.stringify(input) !== budget.snapshot) malformed();
  validLimits(input.budget);
  if (!sameLimits(input.budget, budget.limits)) malformed();
  const links = Object.entries(ledger.sessions).filter(([, link]) => link.runId === runId);
  for (const [session, link] of links) {
    const child = await tx.conversation(link.childId as ConversationId);
    const stage = await tx.task(link.stageId as TaskId);
    if (!child || child.parent !== undefined || !stage || stage.version !== 1 || stage.background || child.owner?.taskId !== link.stageId || child.owner.conversationId !== root.conversationId ||
        stage.kind !== 'jobs.stage' || stage.owner !== runId || stage.conversationId !== root.conversationId ||
        record(stage.input).runId !== runId || record(stage.input).deadline !== input.deadline ||
        !input.steps.some(step => JSON.stringify(step.agent) === JSON.stringify(record(stage.input).agent))) malformed();
    if ((await tx.doc(ProviderDoc, child.id)).sessionId !== session) malformed();
    if (stage.state.status !== 'terminal' && record(stage.state.checkpoint).child !== child.id) malformed();
  }
  for (const item of budget.reservations) {
    const [, childId, stageId, submissionId, generationId, , cutoff] = attemptKey(item.key);
    const link = links.find(([, link]) => link.childId === childId && link.stageId === stageId)?.[1];
    const generation = await tx.task(generationId as TaskId);
    const submission = link && await tx.submissionByRequest(childId as ConversationId, link.requestId);
    const entry = await tx.entry(cutoff as EntryId);
    if (!link || !generation || generation.kind !== 'pi.generation' || generation.version !== 1 || generation.background || generation.conversationId !== childId || generation.owner !== undefined ||
        !submission || submission.type !== 'input' || submission.id !== submissionId || !positive(submission.entry ?? 0) ||
        !entry || entry.kind !== 'pi.system' || entry.byTaskId !== generation.id || entry.conversationId !== childId || entry.id < submission.entry!) malformed();
    if (generation.state.status !== 'terminal' && record(generation.state.checkpoint).phase === 'request' &&
        record(generation.state.checkpoint).attempt === 1 && record(generation.state.checkpoint).cutoff !== cutoff) malformed();
  }
  // A removed association/charge must not erase an already completed native model request.
  let cursor;
  do {
    const page = await tx.scanTasks({ conversationId: root.conversationId, kind: 'jobs.stage' }, 100, cursor);
    cursor = page.next;
    for (const stage of page.items.filter(stage => stage.owner === runId)) {
      let childrenCursor;
      do {
        const children = await tx.scanConversations({ ownerTaskId: stage.id }, 100, childrenCursor);
        childrenCursor = children.next;
        for (const child of children.items) {
          let generationsCursor;
          do {
            const generations = await tx.scanTasks({ conversationId: child.id, kind: 'pi.generation' }, 100, generationsCursor);
            generationsCursor = generations.next;
            for (const generation of generations.items) if (generation.state.status === 'terminal' && generation.state.outcome.status === 'completed' &&
                !budget.reservations.some(item => attemptKey(item.key)[4] === generation.id)) malformed();
          } while (generationsCursor);
        }
      } while (childrenCursor);
    }
  } while (cursor);
  return { budget, root, input };
}
async function modelFreeFinalization(tx: Tx, root: NativeTask, input: AnchoredInput, budget: RunBudget): Promise<boolean> {
  if (root.state.status === 'terminal') return false;
  const checkpoint = record(root.state.checkpoint);
  if (!Array.isArray(checkpoint.stages) || !checkpoint.stages.every(positive)) return false;
  const ids = [...checkpoint.stages] as TaskId[];
  if (checkpoint.phase === 'collect' && ids.length === input.steps.length - 1 && positive(checkpoint.current as number)) ids.push(checkpoint.current as TaskId);
  else if (checkpoint.phase !== 'dispatch' || ids.length !== input.steps.length) return false;
  if (new Set(ids).size !== ids.length) return false;
  let previous: unknown = input.input;
  for (const [index, id] of ids.entries()) {
    const stage = await tx.task(id);
    if (!stage || stage.kind !== 'jobs.stage' || stage.version !== 1 || stage.background || stage.owner !== root.id || stage.conversationId !== root.conversationId ||
        stage.state.status !== 'terminal' || stage.state.outcome.status !== 'completed' || stage.abortRequested) return false;
    const receipt = record(stage.state.outcome.result);
    if (receipt.ok !== true || !Object.hasOwn(receipt, 'value') || record(stage.input).runId !== root.id || record(stage.input).deadline !== input.deadline ||
        JSON.stringify(record(stage.input).agent) !== JSON.stringify(input.steps[index].agent) ||
        JSON.stringify(record(stage.input).input) !== JSON.stringify(previous) || receipt.runId !== root.id || receipt.stageTaskId !== stage.id ||
        receipt.agent !== input.steps[index].agent.name || receipt.outputContractId !== input.steps[index].agent.outputContractId ||
        ![receipt.conversationId, receipt.submissionId, receipt.answerEntryId, receipt.generationTaskId].every(value => positive(value as number))) return false;
    const child = await tx.conversation(receipt.conversationId as ConversationId);
    const submission = await tx.submissionByRequest(receipt.conversationId as ConversationId, `jobs-stage:${stage.id}`);
    const entry = await tx.entry(AssistantEntry, receipt.answerEntryId as EntryId);
    const generation = await tx.task(receipt.generationTaskId as TaskId);
    if (!child || child.owner?.taskId !== stage.id || child.owner.conversationId !== root.conversationId || !submission ||
        submission.type !== 'input' || submission.status !== 'done' || submission.id !== receipt.submissionId || submission.answer !== receipt.answerEntryId ||
        !entry || entry.conversationId !== child.id || entry.byTaskId !== generation?.id || !generation || generation.conversationId !== child.id ||
        generation.state.status !== 'terminal' || generation.state.outcome.status !== 'completed' || record(generation.state.outcome.result).entryId !== entry.id ||
        entry.model?.length !== 1 || entry.model[0].role !== 'assistant' || entry.model[0].stopReason !== 'stop' ||
        entry.model[0].model !== input.steps[index].agent.model.modelId || entry.model[0].provider !== input.steps[index].agent.model.provider ||
        entry.model[0].content.some(part => part.type !== 'text') ||
        !budget.reservations.some(item => item.status === 'settled' && attemptKey(item.key)[4] === generation.id && attemptKey(item.key)[3] === submission.id)) return false;
    previous = receipt.value;
  }
  return true;
}

async function installBudget(tx: Tx, runId: TaskId, input: AnchoredInput, limits: BudgetLimits): Promise<void> {
  checkLimits(limits);
  if (!positive(runId) || input.deadline !== limits.deadline) deny('invalid root');
  validLimits(input.budget);
  if (!positive(input.budgetPerRequestOutputTokens)) malformed();
  if (!sameLimits(input.budget, limits)) deny('budget reconfiguration');
  const snapshot = JSON.stringify(input);
  const normalized = { maxRequests: limits.maxRequests, maxOutputTokens: limits.maxOutputTokens, deadline: limits.deadline };
  const ledger = await tx.doc(BudgetDoc);
  validateLedger(ledger);
  const existing = ledger.runs[String(runId)];
  if (existing) {
    if (!sameLimits(existing.limits, input.budget)) malformed();
    if (existing.snapshot !== snapshot || JSON.stringify(existing.limits) !== JSON.stringify(normalized)) deny('budget reconfiguration');
    return;
  }
  ledger.runs[String(runId)] = { snapshot, limits: normalized, requests: 0, outputTokens: 0, reservations: [] };
}

/** In the SAME commit as tx.createTask(Run,input,...), pass its returned ID and exact input.
 * No table reads after creation. Seed is not authority: the gate revalidates actual persisted root and ownership. */
export async function initializeRootBudget(tx: Tx, newRootId: TaskId, input: AnchoredInput, limits: BudgetLimits): Promise<void> {
  await installBudget(tx, newRootId, input, limits);
}

/** Existing root, e.g. its first dispatch commit before any child creation. */
export async function configureBudget(tx: Tx, runId: TaskId, limits: BudgetLimits): Promise<void> {
  checkLimits(limits);
  if (!positive(runId)) deny('invalid root');
  const root = await tx.task(runId);
  if (!root || root.kind !== 'jobs.run' || root.owner !== undefined || root.state.status === 'terminal' || root.abortRequested ||
      record(root.input).deadline !== limits.deadline) deny('invalid root');
  const ledger = await tx.doc(BudgetDoc);
  validateLedger(ledger);
  if (ledger.runs[String(runId)]) await validateNativeBudget(tx, ledger, runId);
  await installBudget(tx, runId, root.input as AnchoredInput, limits);
}

export type BudgetInspection = { ok: true; requests: number; outputTokens: number; limits: BudgetLimits } |
  { ok: false; reason: 'harness_running' | 'missing_budget' | 'changed_root' | 'malformed_budget' | 'unresolved_reservation' | 'deadline' | 'exhausted' };

/** Read-only admission for a surviving root after open, before any scheduling-enabling call. */
export async function inspectRootBudget(harness: Harness, runId: TaskId, now: number, context: Context): Promise<BudgetInspection> {
  if ((await harness.inspect(context)).scheduling !== 'paused') return { ok: false, reason: 'harness_running' };
  const ledger = await harness.snapshot(BudgetDoc, context);
  if (!ledger) return { ok: false, reason: 'missing_budget' };
  try {
    validateLedger(ledger);
    const budget = ledger.runs[String(runId)];
    if (!budget) return { ok: false, reason: 'missing_budget' };
    const root = await harness.getTask(runId, context);
    if (!root || root.kind !== 'jobs.run' || root.owner !== undefined || root.state.status === 'terminal' || root.abortRequested ||
        JSON.stringify(root.input) !== budget.snapshot || record(root.input).deadline !== budget.limits.deadline) return { ok: false, reason: 'changed_root' };
    return await harness.commit(async tx => {
      const { input, root: validatedRoot } = await validateNativeBudget(tx, ledger, runId);
      if (budget.reservations.some(item => item.status === 'reserved')) return { ok: false, reason: 'unresolved_reservation' } as const;
      if (!Number.isSafeInteger(now) || now >= budget.limits.deadline) return { ok: false, reason: 'deadline' } as const;
      if ((budget.requests >= budget.limits.maxRequests || budget.outputTokens >= budget.limits.maxOutputTokens) &&
          !await modelFreeFinalization(tx, validatedRoot, input, budget)) return { ok: false, reason: 'exhausted' } as const;
      return { ok: true, requests: budget.requests, outputTokens: budget.outputTokens, limits: structuredClone(budget.limits) } as const;
    }, context);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Jobs budget denied:')) return { ok: false, reason: 'malformed_budget' };
    throw error;
  }
}

/** Separate commit after child creation: Tx table reads cannot follow tx.createConversation(). */
export async function associateChild(tx: Tx, runId: TaskId, childId: ConversationId, stageId: TaskId): Promise<void> {
  const child = await tx.conversation(childId);
  const stage = await tx.task(stageId);
  const root = await tx.task(runId);
  if (!child || child.parent !== undefined || !stage || stage.version !== 1 || stage.background || !root || child.owner?.taskId !== stageId || child.owner.conversationId !== stage.conversationId ||
      stage.owner !== runId || stage.kind !== 'jobs.stage' || stage.state.status === 'terminal' || stage.abortRequested ||
      record(stage.input).runId !== runId || record(stage.input).deadline !== record(root.input).deadline ||
      record(stage.state.checkpoint).child !== childId || record(stage.state.checkpoint).phase !== 'answer') deny('child ownership');
  const provider = await tx.doc(ProviderDoc, childId);
  const live = await tx.doc(LiveDoc, childId);
  const ledger = await tx.doc(BudgetDoc);
  await validateNativeBudget(tx, ledger, runId);
  const budget = ledger.runs[String(runId)];
  if (!budget || budget.snapshot !== JSON.stringify(root.input)) deny('missing or changed budget');
  const association = { runId, childId, stageId, requestId: `jobs-stage:${stageId}` };
  const previous = ledger.sessions[provider.sessionId];
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(association)) deny('session already associated');
    return;
  }
  if (live.run || live.generation || live.compactions?.length) deny('child already busy');
  ledger.sessions[provider.sessionId] = association;
}

export type BudgetModelsOptions = {
  provider: Provider;
  model: Model<Api>;
  perRequestOutputTokens: number;
  now: () => number;
  /** Trusted host attestation, not a catalog-derived compatibility claim. getModels is a static,
   * synchronous, externally side-effect-free one-model catalog. apiKey.resolve has no network,
   * shell, refresh or other external effects. Provider honors maxTokens, signal, timeoutMs, maxRetries:0,
   * emits no deferred response and makes at most one external request. */
  providerContract: 'single-request-capped-v1';
};

/** Only streamSimple is admitted. The provider is private so public accessors cannot bypass reservation.
 * SDK source: ai/models.ts streamSimple applies auth lazily; durable/generation.ts persists request identity.
 */
export function createBudgetModels(options: BudgetModelsOptions): { models: Models; bindHarness(harness: Harness): Promise<void> } {
  const model = structuredClone(options.model);
  if (options.providerContract !== 'single-request-capped-v1' || options.provider.id !== model.provider || model.reasoning ||
      model.samplingParams !== undefined || model.headers !== undefined || options.provider.auth.oauth !== undefined ||
      !options.provider.auth.apiKey || options.provider.refreshModels !== undefined ||
      !positive(model.maxTokens) || !positive(options.perRequestOutputTokens) ||
      options.perRequestOutputTokens > model.maxTokens || typeof options.provider.name !== 'string' || !options.provider.name ||
      typeof options.provider.auth.apiKey.name !== 'string' || !options.provider.auth.apiKey.name) deny('unsupported provider/model contract');
  const fingerprint = JSON.stringify(model);
  let catalog: readonly Model<Api>[];
  try { catalog = options.provider.getModels(); } catch { deny('unsupported provider/model contract'); }
  if (!Array.isArray(catalog) || catalog.length !== 1 || JSON.stringify(catalog[0]) !== fingerprint) deny('unsupported provider/model catalog');
  const now = options.now;
  const cap = options.perRequestOutputTokens;
  const delegate = options.provider.streamSimple.bind(options.provider);
  const apiKey = options.provider.auth.apiKey;
  const resolveApiKey = apiKey.resolve.bind(apiKey);
  // Private one-way admission, not replaceable Doc state. Retain failed/uncertain attempts for this binding.
  const admittedAttempts = new Map<string, object>();
  function boundedModels(charge: { runId: TaskId; key: string; tokens: number; deadline: number }) {
    const auth = Object.freeze({ apiKey: Object.freeze({ name: apiKey.name, resolve: async (...args: Parameters<typeof resolveApiKey>) => {
      const resolved = await resolveApiKey(...args);
      // Auth can await: no delegation if the original reservation disappeared or changed meanwhile.
      await harness!.commit(async tx => {
        const ledger = await tx.doc(BudgetDoc);
        const { budget } = await validateNativeBudget(tx, ledger, charge.runId, cap);
        const item = budget.reservations.find(item => item.key === charge.key);
        if (!item || item.status !== 'reserved' || item.tokens !== charge.tokens) deny('reservation changed during auth');
      }, BACKGROUND_CONTEXT);
      return resolved;
    } }) });
    const privateModels = createModels();
    // Construct a public Provider per reservation. Its deadline remains available after asynchronous auth.
    privateModels.setProvider({ id: model.provider, name: options.provider.name, auth,
      getModels: () => [structuredClone(model)], stream: () => deny('raw provider stream'),
      streamSimple: (candidate, context, request) => {
        const remaining = charge.deadline - now();
        if (JSON.stringify(candidate) !== fingerprint || !request || request.maxTokens !== charge.tokens ||
            request.maxRetries !== 0 || !positive(remaining) || request.signal?.aborted || !request.signal ||
            request.reasoning !== undefined || request.samplingParams !== undefined || request.deferred !== undefined ||
            request.headers !== undefined || request.env !== undefined || request.onPayload !== undefined) deny('unsupported final provider options');
        return delegate(candidate, context, { ...request, timeoutMs: remaining });
      },
    });
    return privateModels;
  }
  let harness: Harness | undefined;
  let binding = false;

  async function reserve(candidate: Model<Api>, request: ModelsSimpleStreamOptions) {
    if (!harness) deny('harness not bound');
    if (JSON.stringify(candidate) !== fingerprint || typeof request.sessionId !== 'string' || !request.sessionId ||
        !request.signal || request.signal.aborted || Object.keys(request).some(key => !['sessionId', 'signal', 'maxRetries', 'timeoutMs', 'maxRetryDelayMs'].includes(key)) ||
        (request.maxRetries !== undefined && request.maxRetries !== 0)) deny('unsupported request options');
    // One invocation keeps its token across native transaction retries; another invocation never shares it.
    const admission = {};
    return harness.commit(async tx => {
      const ledger = await tx.doc(BudgetDoc);
      validateLedger(ledger, cap);
      if (!Object.hasOwn(ledger.sessions, request.sessionId!)) deny('unknown session');
      const link = ledger.sessions[request.sessionId!];
      const childId = link.childId as ConversationId;
      const stageId = link.stageId as TaskId;
      const runId = link.runId as TaskId;
      await validateNativeBudget(tx, ledger, runId, cap);
      const child = await tx.conversation(childId);
      const stage = await tx.task(stageId);
      const root = await tx.task(runId);
      const live = await tx.doc(LiveDoc, childId);
      const provider = await tx.doc(ProviderDoc, childId);
      const budget = ledger.runs[String(runId)];
      if (!budget || !child || !stage || !root || root.kind !== 'jobs.run' || root.owner !== undefined || root.abortRequested ||
          root.state.status === 'terminal' || stage.state.status === 'terminal' || stage.abortRequested || stage.kind !== 'jobs.stage' ||
          stage.owner !== runId || child.owner?.taskId !== stageId || child.owner.conversationId !== root.conversationId ||
          stage.conversationId !== root.conversationId || provider.sessionId !== request.sessionId ||
          budget.snapshot !== JSON.stringify(root.input) || record(root.input).deadline !== budget.limits.deadline ||
          record(stage.input).deadline !== budget.limits.deadline || record(stage.input).runId !== runId ||
          record(stage.state.checkpoint).child !== childId || record(stage.state.checkpoint).phase !== 'answer') deny('correlation changed');
      if (!live.run || live.run.inputs.length !== 1 || live.compactions?.length || live.tools?.length || !live.generation) deny('unsupported live generation');
      const generation = await tx.task(live.run.taskId);
      const submission = await tx.submissionByRequest(childId, link.requestId);
      if (!generation || generation.kind !== 'pi.generation' || generation.conversationId !== childId || generation.abortRequested ||
          generation.state.status !== 'running' || !submission || submission.type !== 'input' || submission.status !== 'placed' ||
          submission.id !== live.run.inputs[0]) deny('generation/submission correlation');
      const checkpoint = record(generation.state.checkpoint);
      const ref = record(checkpoint.model);
      const agent = record(record(stage.input).agent);
      const agentModel = record(agent.model);
      const steps = record(root.input).steps;
      if (!Array.isArray(steps) || !steps.some(step => JSON.stringify(record(step).agent) === JSON.stringify(agent)) ||
          agentModel.provider !== model.provider || agentModel.modelId !== model.id || checkpoint.phase !== 'request' ||
          checkpoint.attempt !== 1 || live.generation.attempt !== 1 || checkpoint.compacted !== undefined ||
          checkpoint.thinkingLevel !== 'off' || !positive(checkpoint.cutoff as number) || ref.provider !== model.provider || ref.modelId !== model.id) deny('unsupported generation path');
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp >= budget.limits.deadline || request.signal!.aborted) deny('deadline');
      const key = JSON.stringify([runId, childId, stageId, submission.id, generation.id, checkpoint.attempt, checkpoint.cutoff]);
      const previousAdmission = admittedAttempts.get(key);
      if (previousAdmission && previousAdmission !== admission) deny('attempt already admitted');
      if (budget.reservations.some(item => item.status === 'reserved')) deny('unresolved reservation');
      if (budget.reservations.some(item => item.key === key)) deny('attempt already charged');
      const tokens = Math.min(cap, budget.limits.maxOutputTokens - budget.outputTokens);
      if (budget.requests >= budget.limits.maxRequests || !positive(tokens)) deny('exhausted');
      // No await between private admission and Doc debit. A failed commit remains conservatively consumed.
      admittedAttempts.set(key, admission);
      budget.requests++;
      budget.outputTokens += tokens;
      budget.reservations.push({ key, tokens, status: 'reserved' });
      return { runId, key, tokens, deadline: budget.limits.deadline };
    }, withAbortSignal(request.signal!, BACKGROUND_CONTEXT));
  }

  const unsupported = () => deny('unsupported Models operation');
  // Stable public metadata, never the raw provider/credential resolver. Only streamSimple
  // is supported, and even direct Provider calls enter the same native reservation gate.
  const metadata: Provider = Object.freeze({
    id: model.provider, name: options.provider.name,
    auth: Object.freeze({ apiKey: Object.freeze({ name: apiKey.name, resolve: async () => unsupported() }) }),
    getModels: () => [structuredClone(model)], stream: unsupported,
    streamSimple: (candidate: Model<Api>, context: Parameters<Provider['streamSimple']>[1], request?: Parameters<Provider['streamSimple']>[2]) => models.streamSimple(candidate, context, request),
  });
  const providers = Object.freeze([metadata]);
  const models: Models = {
    getProviders: () => providers, getProvider: id => id === model.provider ? metadata : undefined,
    getModels: provider => provider === undefined || provider === model.provider ? [structuredClone(model)] : [],
    getModel: (provider, id) => provider === model.provider && id === model.id ? structuredClone(model) : undefined,
    getModelsOfType: unsupported, getModelOfType: unsupported, getAllModels: unsupported,
    refresh: unsupported, checkAuth: unsupported, getAvailable: unsupported, getAvailableOfType: unsupported,
    getAllAvailable: unsupported, getAuth: unsupported, login: unsupported, logout: unsupported,
    stream: unsupported, complete: unsupported, completeSimple: unsupported, streamDeferred: unsupported,
    fetchDeferred: unsupported, cancelDeferred: unsupported, generateImages: unsupported, classify: unsupported,
    streamSimple(candidate, context, request = {}) {
      const stream = createAssistantMessageEventStream();
      const safeModel = structuredClone(candidate);
      const safeRequest = { ...request };
      const safeContext = structuredClone(context);
      void (async () => {
        try {
          if (safeContext.tools?.length || safeContext.messages.some(message => message.role === 'toolResult' ||
              (message.role === 'assistant' && message.content.some(part => part.type === 'toolCall')))) deny('tools unsupported');
          const charge = await reserve(safeModel, safeRequest);
          const timestamp = now();
          if (timestamp >= charge.deadline || safeRequest.signal!.aborted) deny('deadline after reservation');
          const signal = AbortSignal.any([safeRequest.signal!, AbortSignal.timeout(charge.deadline - timestamp)]);
          const events = boundedModels(charge).streamSimple(safeModel, safeContext, { sessionId: safeRequest.sessionId,
            signal, maxTokens: charge.tokens, maxRetries: 0, timeoutMs: charge.deadline - timestamp });
          let final: AssistantMessage | undefined;
          for await (const event of events) {
            if (event.type === 'done') final = event.message;
            if (event.type !== 'done') stream.push(event);
          }
          if (!final || final.role !== 'assistant' || final.model !== model.id || final.provider !== model.provider || final.api !== model.api ||
              !['stop', 'length'].includes(final.stopReason) || !Number.isSafeInteger(final.usage.output) || final.usage.output < 0 ||
              final.usage.output > charge.tokens || final.deferred !== undefined ||
              final.content.some(part => part.type !== 'text') || signal.aborted || now() >= charge.deadline) deny('unresolved provider outcome');
          await harness!.commit(async tx => {
            const ledger = await tx.doc(BudgetDoc);
            const { budget } = await validateNativeBudget(tx, ledger, charge.runId, cap);
            const item = budget?.reservations.find(item => item.key === charge.key);
            if (!item || item.status !== 'reserved') deny('reservation changed');
            item.status = 'settled';
          }, withAbortSignal(signal, BACKGROUND_CONTEXT));
          stream.push({ type: 'done', reason: final.stopReason as 'stop' | 'length', message: final });
          stream.end();
        } catch (error) {
          const message: AssistantMessage = { role: 'assistant', api: safeModel.api, provider: safeModel.provider, model: safeModel.id,
            content: [], stopReason: 'error', errorMessage: error instanceof Error ? error.message : String(error), timestamp: now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'error', reason: 'error', error: message }); stream.end();
        }
      })();
      return stream;
    },
  };
  return { models, async bindHarness(candidate) {
    if (harness || binding) deny('harness already bound');
    binding = true;
    try {
      if ((await candidate.inspect(BACKGROUND_CONTEXT)).scheduling !== 'paused') deny('bind requires paused harness');
      // Reopening cannot widen native authority, even when the mutable Doc was coherently rewritten.
      // Leave malformed/missing Doc admission to inspectRootBudget so blocked read/cancel remains possible.
      await candidate.commit(async tx => {
        let cursor;
        do {
          const page = await tx.scanTasks({ kind: 'jobs.run' }, 100, cursor);
          cursor = page.next;
          for (const root of page.items) {
            const input = record(root.input);
            if (Object.hasOwn(input, 'budgetPerRequestOutputTokens') && input.budgetPerRequestOutputTokens !== cap) malformed();
          }
        } while (cursor);
      }, BACKGROUND_CONTEXT);
      harness = candidate;
    } finally { binding = false; }
  } };
}
