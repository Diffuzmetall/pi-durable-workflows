import { isDeepStrictEqual as equal } from 'node:util';
import type { Models } from '@earendil-works/pi-ai';
import type { Context, JsonValue } from '@earendil-works/chord';
import { AgentDoc, AssistantEntry, LiveDoc, type ConversationId, type Cursor, type Harness, type Page,
  type RegistryReader, type TaskId, type TaskRecord } from '@earendil-works/pi-durable';
import { agentCompletion } from './agent-result.ts';
import type { AgentSnapshot, RegisteredAgent, RunInput, StageInput } from './runtime.ts';

type RecordValue = Record<string, unknown>;
type RunCheckpoint = { phase: string; stages: TaskId[]; current?: TaskId };
type StageCheckpoint = { phase: string; child?: ConversationId };
type Receipt = { ok: true; value: JsonValue; runId: TaskId; stageTaskId: TaskId; agent: string; outputContractId: string;
  conversationId: ConversationId; submissionId: number; answerEntryId: number; generationTaskId: number };
type NativeTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
export type StartupResult = { status: 'ready'; runIds: readonly TaskId[] } |
  { status: 'needs_attention'; reason: string };

const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, names: string[]) => object(value) && equal(Object.keys(value).sort(), [...names].sort());
const identity = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
class StartupBlocked extends Error {}
const reject = (reason: string): never => { throw new StartupBlocked(reason); };

async function scan<T>(read: (cursor?: Cursor) => Promise<Page<T, Cursor>>): Promise<T[]> {
  const result: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await read(cursor);
    result.push(...page.items);
    if (result.length > 10_000) reject('scan_limit');
    cursor = page.next;
  } while (cursor !== undefined);
  return result;
}

/**
 * Construct with the SAME registry and registered agents as the Harness/runner.
 * The host must exclusively hold the freshly opened, default-paused Harness until ALL
 * startup gates (including separate budget/unresolved-reservation admission) pass. Native
 * ready is NOT global permission: absent/unknown external gate results must block resume.
 * Never submit, wait, abort a
 * Conversation, mutate registry/models, or resume during inspection. This function never
 * resumes and its result is not a durable permission or a selective-resume capability.
 */
export function createJobsPreflight(options: {
  agents: readonly RegisteredAgent[]; ownerConversationIds: readonly ConversationId[]; registry: RegistryReader; models: Models;
}) {
  const registry = options.registry.snapshot();
  const owners = new Set(options.ownerConversationIds);
  if (![...owners].every(identity)) throw new Error('Invalid trusted owner');
  const agents = new Map(options.agents.map(({ output, ...snapshot }) => [snapshot.name, {
    snapshot: structuredClone(snapshot), output: { validate: output.validate.bind(output), succeeded: output.succeeded.bind(output) },
  }]));
  if (agents.size !== options.agents.length) throw new Error('Duplicate agent registration');
  const models = [...agents.values()].map(({ snapshot: { model } }) => ({ ref: model,
    model: structuredClone(options.models.getModel(model.provider, model.modelId)),
    provider: options.models.getProvider(model.provider),
  }));
  const sameModels = () => models.every(({ ref, model, provider }) => model !== undefined && provider !== undefined &&
    options.models.getProvider(ref.provider) === provider && equal(options.models.getModel(ref.provider, ref.modelId), model));
  return async (harness: Harness, context: Context): Promise<StartupResult> => {
    try {
      if ((await harness.inspect(context)).scheduling !== 'paused') reject('harness_not_paused');
      if (options.registry.snapshot() !== registry || registry.task('jobs.run')?.definition.version !== 1 ||
          registry.task('jobs.stage')?.definition.version !== 1) reject('registry_changed');
      if (!sameModels()) reject('model_catalog_changed');
      const data = await harness.commit(async tx => ({
        tasks: await scan(cursor => tx.scanTasks({}, 100, cursor)),
        conversations: await scan(cursor => tx.scanConversations({}, 100, cursor)),
      }), context);
      const tasks = new Map<TaskId, NativeTask>(data.tasks.map(task => [task.id, task]));
      const conversations = new Map(data.conversations.map(conversation => [conversation.id, conversation]));
      const accounted = new Set<TaskId>();
      const childConversations = new Set<ConversationId>();
      const allowedSubmissions = new Set<number>();
      const runs = data.tasks.filter(task => task.kind === 'jobs.run');
      for (const run of runs) {
        if (run.version !== 1 || run.owner !== undefined || !run.background || !owners.has(run.conversationId) ||
            !conversations.has(run.conversationId)) reject('invalid_run_owner');
        accounted.add(run.id);
        const input = run.input as RunInput & {
          budget?: { maxRequests: number; maxOutputTokens: number; deadline: number }; budgetPerRequestOutputTokens?: number;
        };
        const anchored = keys(input, ['steps', 'input', 'deadline', 'budget', 'budgetPerRequestOutputTokens']);
        if ((!keys(input, ['steps', 'input', 'deadline']) && !anchored) || !Array.isArray(input.steps) || !input.steps.length ||
            input.steps.length > 64 || !Number.isSafeInteger(input.deadline) || input.deadline <= 0) reject('invalid_run_input');
        // Immutable native anchors are structural only; the separate budget gate still owns authority.
        if (anchored && (!keys(input.budget, ['maxRequests', 'maxOutputTokens', 'deadline']) ||
            !identity(input.budget?.maxRequests) || !identity(input.budget?.maxOutputTokens) ||
            input.budget?.deadline !== input.deadline || !identity(input.budgetPerRequestOutputTokens))) reject('invalid_run_input');
        const stepIds = new Set<string>();
        for (const step of input.steps) {
          if (!keys(step, ['id', 'agent']) || typeof step.id !== 'string' || !step.id || stepIds.has(step.id) ||
              !object(step.agent) || !equal(agents.get(step.agent.name)?.snapshot, step.agent)) reject('agent_identity_changed');
          if (anchored) {
            const maxTokens = models.find(({ ref }) => equal(ref, step.agent.model))?.model?.maxTokens;
            if (!identity(maxTokens) || input.budgetPerRequestOutputTokens! > maxTokens) reject('invalid_run_input');
          }
          stepIds.add(step.id);
        }
        const state = run.state;
        let refs: TaskId[];
        let current: TaskId | undefined;
        if (state.status === 'terminal') {
          if (state.outcome.status !== 'completed' || !keys(state.outcome.result, ['stages'])) reject('unsupported_run_outcome');
          refs = (state.outcome.result as { stages: TaskId[] }).stages;
          if (!Array.isArray(refs) || refs.length !== input.steps.length) reject('invalid_run_receipt');
        } else {
          const checkpoint = state.checkpoint as RunCheckpoint;
          if (!object(checkpoint) || !['pending', 'waiting'].includes(state.status) ||
              !keys(checkpoint, checkpoint.phase === 'dispatch' ? ['phase', 'stages'] : ['phase', 'stages', 'current']) ||
              !['dispatch', 'collect'].includes(checkpoint.phase)) reject('unsupported_run_checkpoint');
          refs = checkpoint.stages;
          current = checkpoint.phase === 'collect' ? checkpoint.current : undefined;
          if (!Array.isArray(refs) || refs.length > input.steps.length ||
              (current !== undefined && (!identity(current) || refs.length >= input.steps.length)) ||
              (state.status === 'waiting' && (!current || state.policy !== 'allSettled' || !equal(state.on, [current])))) reject('invalid_run_checkpoint');
        }
        const expectedIds = [...refs, ...(current === undefined ? [] : [current])];
        if (!expectedIds.every(identity) || new Set(expectedIds).size !== expectedIds.length ||
            !equal(data.tasks.filter(task => task.owner === run.id).map(task => task.id).sort((a,b) => a-b),
              [...expectedIds].sort((a,b) => a-b))) reject('unexpected_stage_descendant');
        let value = input.input;
        for (const [index, id] of expectedIds.entries()) {
          const stage = tasks.get(id);
          const agent = input.steps[index].agent;
          if (!stage || stage.kind !== 'jobs.stage' || stage.version !== 1 || stage.owner !== run.id || stage.background ||
              stage.conversationId !== run.conversationId || !equal(stage.input, { runId: run.id, agent, input: value, deadline: input.deadline })) reject('invalid_stage_identity');
          accounted.add(id);
          const result = await inspectStage(stage!, index < refs.length, agent);
          if (result !== undefined) value = result;
        }
      }
      for (const task of data.tasks) {
        if (!accounted.has(task.id) && (task.kind.startsWith('jobs.') || task.state.status !== 'terminal' ||
            childConversations.has(task.conversationId) || (task.owner !== undefined && accounted.has(task.owner)))) reject('unaccounted_task');
      }
      for (const conversation of data.conversations) {
        if (conversation.owner && accounted.has(conversation.owner.taskId) && !childConversations.has(conversation.id)) reject('unexpected_conversation');
        if (!childConversations.has(conversation.id) && !equal(await harness.snapshot(LiveDoc, conversation.id, context), {})) reject('invalid_idle_controls');
      }
      const inspection = await harness.inspect(context);
      if (inspection.scheduling !== 'paused' || options.registry.snapshot() !== registry || !sameModels()) reject('startup_changed');
      for (const submission of inspection.submissions) {
        if (!allowedSubmissions.has(submission.id)) reject('unaccounted_submission');
      }
      return { status: 'ready', runIds: runs.map(run => run.id) };

      async function inspectStage(stage: NativeTask, mustComplete: boolean, agent: AgentSnapshot): Promise<JsonValue | undefined> {
        const state = stage.state;
        const receipt = state.status === 'terminal' && state.outcome.status === 'completed' && object(state.outcome.result)
          ? state.outcome.result as Receipt : undefined;
        if (mustComplete && !receipt) reject('missing_stage_receipt');
        const checkpoint = state.status === 'pending' || state.status === 'waiting' ? state.checkpoint as StageCheckpoint : undefined;
        if (!receipt && (!object(checkpoint) || !keys(checkpoint, checkpoint.phase === 'prepare' ? ['phase'] : ['phase', 'child']) ||
            !['prepare', 'answer'].includes(checkpoint.phase) || state.status !== 'pending')) reject('unsupported_stage_checkpoint');
        const children = data.conversations.filter(conversation => conversation.owner?.taskId === stage.id);
        if (!receipt && checkpoint?.phase === 'prepare') {
          if (children.length || data.tasks.some(task => task.owner === stage.id)) reject('unexpected_prepare_descendant');
          return undefined;
        }
        const childId = receipt?.conversationId ?? checkpoint?.child;
        if (!identity(childId)) reject('invalid_conversation_owner');
        const child = conversations.get(childId!);
        if (!identity(childId) || children.length !== 1 || children[0].id !== childId || child?.parent ||
            child?.owner?.conversationId !== stage.conversationId) reject('invalid_conversation_owner');
        childConversations.add(childId!);
        const configured = await harness.snapshot(AgentDoc, childId!, context);
        if (!equal(configured, { model: agent.model, instructions: agent.instructions, extensions: [], tools: [], modelTools: [] })) reject('agent_configuration_changed');
        const live = await harness.snapshot(LiveDoc, childId!, context);
        const descendants = data.tasks.filter(task => task.conversationId === childId || task.owner === stage.id);
        const { submission, entries } = await harness.commit(async tx => ({
          submission: await tx.submissionByRequest(childId!, `jobs-stage:${stage.id}`),
          entries: await scan(cursor => tx.scanEntries({ conversationId: childId! }, 100, cursor)),
        }), context);
        if (!receipt && !submission) {
          if (descendants.length || entries.length) reject('unexpected_generation');
          if (!equal(live, {})) reject('invalid_idle_controls');
          return undefined;
        }
        if (!submission || submission.type !== 'input' || submission.conversationId !== childId ||
            submission.requestId !== `jobs-stage:${stage.id}` || descendants.length !== 1) reject('invalid_submission');
        const systems = entries.filter(entry => entry.kind === 'pi.system');
        const expectedSystem = { instructions: `<instructions>\n${agent.instructions}\n</instructions>` };
        if (systems.length > 1 || systems.some(entry => entry.byTaskId !== descendants[0].id ||
            entry.model?.length !== 1 || entry.model[0].role !== 'system' || entry.model[0].content !== '' ||
            !equal(entry.model[0].sections, expectedSystem) || !keys(entry.model[0], ['role', 'content', 'sections', 'timestamp']))) reject('unexpected_system_prompt');
        const entryIds = [submission!.entry, ...(submission!.status === 'done' ? [submission!.answer] : []), ...systems.map(entry => entry.id)];
        if (!equal(entries.map(entry => entry.id).sort((a,b) => a-b), entryIds.sort((a,b) => a!-b!))) reject('unexpected_transcript');
        allowedSubmissions.add(submission!.id);
        const inputEntry = await harness.commit(tx => tx.entry(submission!.entry!), context);
        if (!inputEntry || inputEntry.conversationId !== childId || inputEntry.kind !== 'pi.user' ||
            !Array.isArray(inputEntry.model) || inputEntry.model.length !== 1 || inputEntry.model[0].role !== 'user' ||
            inputEntry.model[0].content !== JSON.stringify((stage.input as StageInput).input)) reject('invalid_submission_input');
        const generation = descendants[0];
        if (generation.kind !== 'pi.generation' || generation.version !== 1 || generation.owner !== undefined ||
            generation.background || generation.conversationId !== childId || !keys(generation.input, [])) reject('invalid_generation');
        accounted.add(generation.id);
        if (receipt || generation.state.status === 'terminal') {
          if (!equal(live, {})) reject('invalid_idle_controls');
          if (systems.length !== 1) reject('missing_system_prompt');
          const entry = submission!.type === 'input' && submission!.status === 'done'
            ? await harness.commit(tx => tx.entry(AssistantEntry, submission!.answer!), context) : undefined;
          const completed = agentCompletion({ conversationId: childId!, ownerConversationId: stage.conversationId,
            ownerTaskId: stage.id, submissionId: submission!.id, requestId: `jobs-stage:${stage.id}` },
            { conversation: child, submission, entry, generation }, agents.get(agent.name)!.output);
          const message = entry?.model?.[0];
          if (!message || message.role !== 'assistant' || message.provider !== agent.model.provider || message.model !== agent.model.modelId) reject('answer_model_changed');
          if (!completed.ok || (receipt && (!keys(receipt, ['ok', 'value', 'runId', 'stageTaskId', 'agent', 'outputContractId',
              'conversationId', 'submissionId', 'answerEntryId', 'generationTaskId']) || receipt.ok !== true || !equal(receipt.value, completed.value) || receipt.runId !== (stage.input as StageInput).runId ||
              receipt.stageTaskId !== stage.id || receipt.agent !== agent.name || receipt.outputContractId !== agent.outputContractId ||
              receipt.submissionId !== completed.submissionId || receipt.answerEntryId !== completed.answerEntryId ||
              receipt.generationTaskId !== completed.generationTaskId))) reject('invalid_stage_receipt');
          return completed.ok ? completed.value as JsonValue : undefined;
        }
        if (receipt || systems.length !== 0 || generation.state.status !== 'pending' ||
            !equal(generation.state.checkpoint, { phase: 'prepare', attempt: 1 }) ||
            generation.abortRequested || (generation.memos !== undefined && Object.keys(generation.memos).length > 0) || submission!.status !== 'placed') reject('unsafe_unfinished_generation');
        if (!equal(live, { run: { taskId: generation.id, inputs: [submission!.id] } })) reject('invalid_pending_controls');
        return undefined;
      }
    } catch (error) {
      return { status: 'needs_attention', reason: error instanceof StartupBlocked ? error.message : 'inspection_failed' };
    }
  };
}
