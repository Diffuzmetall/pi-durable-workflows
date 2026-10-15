import type { Context } from '@earendil-works/chord';
import type { ConversationId, Harness, TaskId } from '@earendil-works/pi-durable';

export class RunNotFound extends Error {
  constructor() { super('Run not found'); this.name = 'RunNotFound'; }
}

/** ownerConversationId must come from authenticated host context, never user JSON. */
export async function getOwnedRun(harness: Harness, ownerConversationId: ConversationId, runId: TaskId, context: Context) {
  if (!Number.isSafeInteger(ownerConversationId) || ownerConversationId <= 0 ||
      !Number.isSafeInteger(runId) || runId <= 0) throw new RunNotFound();
  const run = await harness.getTask(runId, context);
  if (!run || run.kind !== 'jobs.run' || run.conversationId !== ownerConversationId ||
      run.owner !== undefined || run.background !== true) throw new RunNotFound();
  return run;
}

/** Marks native owned cancellation without enabling Harness-wide scheduling. */
export async function cancelOwnedRun(harness: Harness, ownerConversationId: ConversationId, runId: TaskId, context: Context) {
  const run = await getOwnedRun(harness, ownerConversationId, runId, context);
  return harness.abortTask(run.id, context);
}
