import type { OutputContract } from './types.ts';
import { synchronousTrue } from './schema.ts';

export type ExpectedAgentAnswer = {
  readonly conversationId: number;
  readonly ownerTaskId: number;
  readonly ownerConversationId: number;
  readonly submissionId: number;
  readonly requestId: string;
};

export type AgentCompletion =
  | { readonly ok: true; readonly value: unknown; readonly conversationId: number;
      readonly submissionId: number; readonly answerEntryId: number; readonly generationTaskId: number }
  | { readonly ok: false; readonly reason: 'invalid_identity' | 'not_completed' | 'invalid_answer' | 'invalid_result' | 'domain_error' };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function id(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Read all evidence from scoped native APIs; this parser does not authorize access or retrieve records. */
export function agentCompletion(
  expected: ExpectedAgentAnswer,
  evidence: unknown,
  contract: OutputContract,
): AgentCompletion {
  const records = record(evidence);
  const conversation = record(records?.conversation);
  const owner = record(conversation?.owner);
  const submission = record(records?.submission);
  const entry = record(records?.entry);
  const generation = record(records?.generation);
  if (![expected.conversationId, expected.ownerConversationId, expected.ownerTaskId, expected.submissionId].every(id) ||
      typeof expected.requestId !== 'string' || expected.requestId.length === 0 ||
      !conversation || !submission || !entry || !generation ||
      conversation.id !== expected.conversationId || owner?.conversationId !== expected.ownerConversationId || owner.taskId !== expected.ownerTaskId ||
      submission.id !== expected.submissionId || submission.conversationId !== expected.conversationId ||
      submission.requestId !== expected.requestId || !id(submission.answer) || !id(submission.entry) ||
      entry.id !== submission.answer || entry.conversationId !== expected.conversationId ||
      entry.kind !== 'pi.assistant' || !id(entry.byTaskId) || generation.id !== entry.byTaskId ||
      generation.kind !== 'pi.generation' || generation.conversationId !== expected.conversationId) {
    return { ok: false, reason: 'invalid_identity' };
  }
  const state = record(generation.state);
  const outcome = record(state?.outcome);
  if (submission.type !== 'input' || submission.status !== 'done' ||
      state?.status !== 'terminal' || outcome?.status !== 'completed') return { ok: false, reason: 'not_completed' };
  if (record(outcome.result)?.entryId !== entry.id) return { ok: false, reason: 'invalid_identity' };
  if (!Array.isArray(entry.model) || entry.model.length !== 1) return { ok: false, reason: 'invalid_answer' };
  const message = record(entry.model[0]);
  // Native done also accepts length/toolUse; only a normal final stop is a Jobs answer.
  if (message?.role !== 'assistant' || message.stopReason !== 'stop' || !Array.isArray(message.content)) {
    return { ok: false, reason: 'invalid_answer' };
  }
  let text = '';
  let bytes = 0;
  for (const part of message.content) {
    const block = record(part);
    if (block?.type === 'thinking') continue;
    if (block?.type !== 'text' || typeof block.text !== 'string') return { ok: false, reason: 'invalid_answer' };
    bytes += new TextEncoder().encode(block.text).byteLength;
    if (bytes > 65_536) return { ok: false, reason: 'invalid_answer' };
    text += block.text;
  }
  try {
    const value: unknown = JSON.parse(text, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Nonfinite JSON');
      return item;
    });
    if (!synchronousTrue(contract.validate(value))) return { ok: false, reason: 'invalid_result' };
    if (!synchronousTrue(contract.succeeded(value))) return { ok: false, reason: 'domain_error' };
    return { ok: true, value, conversationId: expected.conversationId, submissionId: expected.submissionId,
      answerEntryId: submission.answer, generationTaskId: entry.byTaskId };
  } catch {
    return { ok: false, reason: 'invalid_result' };
  }
}
