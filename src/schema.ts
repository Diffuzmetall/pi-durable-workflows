import type { OutputContract, ToolCompletion, ToolReceiptReference } from './types.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Both result boundaries reject async validators without leaving rejected promises unobserved. */
export function synchronousTrue(value: unknown): boolean {
  if (value === true) return true;
  // Observe native promises, including cross-realm ones, without accepting async validation.
  try { void Promise.prototype.then.call(value, undefined, () => undefined); } catch { /* Not a native promise. */ }
  return false;
}

/** Fresh 1.2 only. Legacy untagged receipts require a separately accepted migration. */
export function toolReceiptReference(value: unknown): ToolReceiptReference {
  if (!record(value)) throw new Error('Invalid tool receipt');
  if (value.kind === 'nested' && !Object.hasOwn(value, 'entryId')) return { kind: 'nested' };
  if (value.kind === 'model' && id(value.entryId)) return { kind: 'model', entryId: value.entryId };
  throw new Error('Invalid tool receipt');
}

/**
 * A native completed task can contain an isError result. Neither Promise resolution
 * nor a transcript tool result is a final worker-stage answer. Caller must read the
 * scoped nested result before its parent settles/retirement, then persist a Jobs receipt.
 */
export function nestedToolCompletion(
  taskOutcome: unknown,
  nestedResult: unknown,
  expectedTaskId: number,
  contract: OutputContract,
): ToolCompletion {
  if (!record(taskOutcome) || taskOutcome.status !== 'completed') {
    return { ok: false, reason: 'task_not_completed' };
  }
  if (!record(taskOutcome.result) || taskOutcome.result.kind !== 'nested' ||
      Object.hasOwn(taskOutcome.result, 'entryId')) return { ok: false, reason: 'invalid_result' };
  if (!record(nestedResult) || !id(expectedTaskId) || nestedResult.taskId !== expectedTaskId ||
      typeof nestedResult.isError !== 'boolean' || !Array.isArray(nestedResult.diagnostics)) {
    return { ok: false, reason: 'invalid_result' };
  }
  if (nestedResult.isError) return { ok: false, reason: 'tool_error' };
  for (const diagnostic of nestedResult.diagnostics) {
    if (!record(diagnostic) || typeof diagnostic.severity !== 'string' ||
        !['info', 'warn', 'error'].includes(diagnostic.severity) ||
        typeof diagnostic.message !== 'string') return { ok: false, reason: 'invalid_result' };
    if (diagnostic.severity === 'error') return { ok: false, reason: 'tool_error' };
  }
  // Missing output fails closed. Empty output from a no-schema tool is native "".
  if (!Object.hasOwn(nestedResult, 'structuredOutput') || nestedResult.structuredOutput === undefined) {
    return { ok: false, reason: 'invalid_result' };
  }
  try {
    if (!synchronousTrue(contract.validate(nestedResult.structuredOutput))) return { ok: false, reason: 'invalid_result' };
    if (!synchronousTrue(contract.succeeded(nestedResult.structuredOutput))) return { ok: false, reason: 'domain_error' };
  } catch {
    // Do not leak schema/provider/private output text through generic diagnostics.
    return { ok: false, reason: 'invalid_result' };
  }
  return { ok: true, value: nestedResult.structuredOutput };
}
