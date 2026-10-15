/** Candidate-facing boundaries for Durable 1.2; not worker/LLM stage receipts. */
export type ToolReceiptReference =
  | { readonly kind: 'model'; readonly entryId: number }
  | { readonly kind: 'nested' };

export type ToolCompletion =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'task_not_completed' | 'tool_error' | 'invalid_result' | 'domain_error' };

/** The registered action, not this generic adapter, owns its output schema. */
export type OutputContract = {
  readonly validate: (value: unknown) => boolean;
  readonly succeeded: (value: unknown) => boolean;
};
