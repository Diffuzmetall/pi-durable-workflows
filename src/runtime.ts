import { AssistantEntry, configure, defineTask, type ConversationId, type TaskId, type Tx } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import { withAbortSignal } from '@earendil-works/chord/context';
import { agentCompletion } from './agent-result.ts';
import type { OutputContract } from './types.ts';

export type AgentSnapshot = {
  name: string; implementationId: string; outputContractId: string;
  model: { provider: string; modelId: string }; instructions: string;
};
export type RegisteredAgent = AgentSnapshot & { output: OutputContract };
export type StageInput = { runId: TaskId; agent: AgentSnapshot; input: JsonValue; deadline: number };
type StageState = { phase: 'prepare' } | { phase: 'answer'; child: ConversationId } | { phase: 'timeout'; child: ConversationId };
type StageReceipt = {
  runId: TaskId; stageTaskId: TaskId; agent: string; outputContractId: string; value: JsonValue;
  conversationId: number; submissionId: number; answerEntryId: number; generationTaskId: number;
};
const failed = (code: string) => ({ status: 'terminal', outcome: { status: 'failed', error: { message: 'Agent stage failed', detail: { code } } } } as const);

/** Internal stage primitive; public admission and paused-startup barrier remain separate work. */
export function createStageTask(agents: readonly RegisteredAgent[],
  beforeSubmission?: (tx: Tx, runId: TaskId, childId: ConversationId, stageId: TaskId) => Promise<void>) {
  const registrations = new Map<string, { snapshot: AgentSnapshot; output: OutputContract }>();
  for (const { output, ...snapshot } of agents) {
    if (registrations.has(snapshot.name)) throw new Error('Duplicate agent registration');
    registrations.set(snapshot.name, { snapshot: structuredClone(snapshot), output: {
      validate: output.validate.bind(output), succeeded: output.succeeded.bind(output),
    } });
  }
  return defineTask<StageInput, StageState, StageReceipt, {}>({
    name: 'jobs.stage', version: 1, initial: () => ({ phase: 'prepare' }),
    phases: {
      async prepare(task, runtime, context) {
        const registered = registrations.get(task.input.agent.name);
        if (!registered || JSON.stringify(registered.snapshot) !== JSON.stringify(task.input.agent)) {
          await runtime.commit(() => failed('needs_attention'), context); return;
        }
        if (runtime.now() >= task.input.deadline) { await runtime.commit(() => failed('deadline'), context); return; }
        await runtime.commit(async tx => {
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } });
          await configure(tx, child.id, { model: task.input.agent.model, instructions: task.input.agent.instructions,
            extensions: [], tools: [], modelTools: [], cwd: null });
          return { status: 'running', checkpoint: { phase: 'answer', child: child.id } };
        }, context);
      },
      async answer(task, runtime, context) {
        const { child } = task.state.checkpoint;
        const registered = registrations.get(task.input.agent.name);
        if (!registered || JSON.stringify(registered.snapshot) !== JSON.stringify(task.input.agent)) {
          await runtime.commit(() => failed('needs_attention'), context); return;
        }
        if (runtime.now() >= task.input.deadline) {
          await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'timeout', child } }), context); return;
        }
        const handle = await runtime.conversation(child, context);
        if (!handle) { await runtime.commit(() => failed('needs_attention'), context); return; }
        if (beforeSubmission) {
          try {
            await runtime.commit(async tx => {
              await beforeSubmission(tx, task.input.runId, child, runtime.taskId);
            }, context);
          } catch {
            await runtime.commit(() => failed('needs_attention'), context); return;
          }
        }
        const requestId = `jobs-stage:${runtime.taskId}`;
        const submission = await handle.submit({ type: 'input', content: JSON.stringify(task.input.input), requestId }, context);
        const controller = new AbortController();
        const waitContext = withAbortSignal(controller.signal, context);
        try {
          const result = await Promise.race([
            (async () => {
              const settled = await submission.wait(waitContext);
              if (settled.type !== 'input' || settled.status !== 'done') return { kind: 'failure', reason: 'invalid_answer' } as const;
              let evidence: unknown;
              let generationId: TaskId | undefined;
              await runtime.commit(async tx => {
                const entry = await tx.entry(AssistantEntry, settled.answer);
                evidence = { conversation: await tx.conversation(child), submission: settled, entry };
                generationId = entry?.byTaskId;
              }, waitContext);
              if (!generationId) return { kind: 'failure', reason: 'invalid_answer' } as const;
              const generation = await runtime.waitForTask(generationId, waitContext);
              const completion = agentCompletion({ conversationId: child, ownerConversationId: runtime.conversationId,
                ownerTaskId: runtime.taskId, submissionId: submission.id, requestId }, { ...(evidence as object), generation }, registered.output);
              return { kind: 'completion', completion } as const;
            })(),
            runtime.sleep(task.input.deadline, waitContext).then(() => ({ kind: 'timeout' } as const)),
          ]);
          controller.abort();
          await runtime.commit(() => {
            if (result.kind === 'timeout' || runtime.now() >= task.input.deadline) {
              return { status: 'running', checkpoint: { phase: 'timeout', child } };
            }
            if (result.kind === 'failure') return failed(result.reason);
            const { completion } = result;
            if (!completion.ok) return failed(completion.reason);
            const receipt: StageReceipt = { ...completion, value: completion.value as JsonValue, runId: task.input.runId,
              stageTaskId: runtime.taskId, agent: task.input.agent.name, outputContractId: task.input.agent.outputContractId };
            return { status: 'terminal', outcome: { status: 'completed', result: receipt } };
          }, context);
        } finally { controller.abort(); }
      },
      async timeout(task, runtime, context) {
        const handle = await runtime.conversation(task.state.checkpoint.child, context);
        if (!handle) { await runtime.commit(() => failed('needs_attention'), context); return; }
        await handle.abort(context);
        await runtime.commit(() => failed('deadline'), context);
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
    },
  });
}

export type RunInput = {
  steps: { id: string; agent: AgentSnapshot }[]; input: JsonValue; deadline: number;
};
type RunState = { phase: 'dispatch'; stages: TaskId<StageReceipt>[] } |
  { phase: 'collect'; stages: TaskId<StageReceipt>[]; current: TaskId<StageReceipt> };
type RunReceipt = { stages: TaskId<StageReceipt>[] };

/** Internal sequential coordinator; public admission and paused-startup guards remain separate work. */
export function createRunTask(Stage: ReturnType<typeof createStageTask>) {
  const fail = (code: string, stages: TaskId<StageReceipt>[]) => ({ status: 'terminal',
    outcome: { status: 'failed', result: { stages }, error: { message: 'Durable run failed', detail: { code } } },
  } as const);
  return defineTask<RunInput, RunState, RunReceipt, {}>({
    name: 'jobs.run', version: 1,
    initial: input => {
      if (!input.steps.length || input.steps.length > 64 || !Number.isSafeInteger(input.deadline) ||
          new Set(input.steps.map(step => step.id)).size !== input.steps.length) throw new Error('Invalid run input');
      return { phase: 'dispatch', stages: [] };
    },
    phases: {
      async dispatch(task, runtime, context) {
        const { stages } = task.state.checkpoint;
        const previous = stages.length ? await runtime.getTask(stages[stages.length - 1], context) : undefined;
        if (stages.length && (!previous || previous.owner !== runtime.taskId || previous.state.status !== 'terminal' ||
            previous.state.outcome.status !== 'completed' || previous.state.outcome.result.runId !== runtime.taskId ||
            previous.state.outcome.result.stageTaskId !== previous.id)) {
          await runtime.commit(() => fail('needs_attention', stages), context); return;
        }
        const value = previous?.state.status === 'terminal' && previous.state.outcome.status === 'completed'
          ? previous.state.outcome.result.value : task.input.input;
        await runtime.commit(async tx => {
          if (runtime.now() >= task.input.deadline) return fail('deadline', stages);
          if (stages.length === task.input.steps.length) {
            return { status: 'terminal', outcome: { status: 'completed', result: { stages } } };
          }
          const current = await tx.createTask(Stage, { runId: runtime.taskId,
            agent: task.input.steps[stages.length].agent, input: value, deadline: task.input.deadline,
          }, { ownership: { kind: 'task', taskId: runtime.taskId } });
          return { status: 'running', checkpoint: { phase: 'collect', stages, current } };
        }, context);
      },
      async collect(task, runtime, context) {
        const { stages, current } = task.state.checkpoint;
        const stage = await runtime.waitForTask(current, context);
        await runtime.commit(() => {
          if (stage.owner !== runtime.taskId || stage.conversationId !== runtime.conversationId) return fail('needs_attention', stages);
          if (stage.state.outcome.status !== 'completed') {
            return { status: 'terminal', outcome: { status: 'failed', result: { stages },
              error: { message: 'Agent stage failed', detail: { code: 'stage_failed', stageTaskId: current } } } };
          }
          const receipt = stage.state.outcome.result;
          if (receipt.runId !== runtime.taskId || receipt.stageTaskId !== current ||
              receipt.agent !== task.input.steps[stages.length].agent.name ||
              receipt.outputContractId !== task.input.steps[stages.length].agent.outputContractId) return fail('needs_attention', stages);
          return { status: 'running', checkpoint: { phase: 'dispatch', stages: [...stages, current] } };
        }, context);
      },
    },
    async abort(task, runtime, context) {
      for (const child of await runtime.ownedTasks(context)) await runtime.abortOwned(child.id, context);
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', result: { stages: task.state.checkpoint.stages } } }), context);
    },
  });
}
