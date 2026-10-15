import { Buffer } from 'node:buffer';
import type { RegisteredAgent, RunInput } from './runtime.ts';

export type AdmissionLimits = {
  readonly maxSteps: number; readonly maxInputBytes: number; readonly maxRequests: number;
  readonly maxOutputTokens: number; readonly timeoutMs: number;
};
export type AdmissionPolicy = {
  readonly agents: readonly RegisteredAgent[];
  readonly allowedAgents: readonly string[];
  readonly limits: AdmissionLimits;
};

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
function invalid(): never { throw new Error('Invalid Jobs admission'); }

function record(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || !descriptor.enumerable) invalid();
  }
  if (Object.getOwnPropertySymbols(value).length) invalid();
}

function keys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) invalid();
}

function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid();
}

function name(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) invalid();
}

function parse(json: string, maxBytes: number): unknown {
  if (typeof json !== 'string' || json.length > maxBytes || Buffer.byteLength(json, 'utf8') > maxBytes) invalid();
  try { return JSON.parse(json); } catch { return invalid(); }
}

function safeInput(value: unknown, depth = 0): asserts value is RunInput['input'] {
  if (depth > 32) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid();
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) safeInput(child, depth + 1);
    return;
  }
  record(value);
  for (const [key, child] of Object.entries(value)) {
    if (unsafeKeys.has(key)) invalid();
    safeInput(child, depth + 1);
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function admitDefinition(
  definitionJson: string, inputJson: string, policy: AdmissionPolicy, now: number,
): { run: RunInput; limits: AdmissionLimits } {
  record(policy);
  keys(policy, ['agents', 'allowedAgents', 'limits']);
  record(policy.limits);
  keys(policy.limits, ['maxSteps', 'maxInputBytes', 'maxRequests', 'maxOutputTokens', 'timeoutMs']);
  for (const cap of Object.values(policy.limits)) {
    if (!Number.isSafeInteger(cap) || cap <= 0) invalid();
  }
  if (policy.limits.maxSteps > 64 || !Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(now + policy.limits.timeoutMs)) invalid();
  const limits = { ...policy.limits };
  if (!Array.isArray(policy.agents) || !Array.isArray(policy.allowedAgents)) invalid();
  const agents = new Map<string, RunInput['steps'][number]['agent']>();
  const registrations: readonly RegisteredAgent[] = policy.agents;
  for (const agent of registrations) {
    record(agent);
    keys(agent, ['name', 'implementationId', 'outputContractId', 'model', 'instructions', 'output']);
    name(agent.name);
    text(agent.implementationId); text(agent.outputContractId); text(agent.instructions);
    record(agent.model); keys(agent.model, ['provider', 'modelId']);
    text(agent.model.provider); text(agent.model.modelId);
    if (!agent.output || typeof agent.output.validate !== 'function' || typeof agent.output.succeeded !== 'function' ||
        agents.has(agent.name)) invalid();
    const { output: _output, ...snapshot } = agent;
    agents.set(agent.name, structuredClone(snapshot));
  }
  const allowed = new Set<string>();
  for (const agent of policy.allowedAgents) {
    name(agent);
    if (!agents.has(agent) || allowed.has(agent)) invalid();
    allowed.add(agent);
  }
  const definition = parse(definitionJson, limits.maxInputBytes);
  record(definition); keys(definition, ['version', 'steps']);
  if (definition.version !== 1 || !Array.isArray(definition.steps) ||
      definition.steps.length === 0 || definition.steps.length > limits.maxSteps) invalid();
  const seen = new Set<string>();
  const steps: RunInput['steps'] = definition.steps.map(step => {
    record(step); keys(step, ['id', 'agent']);
    name(step.id); name(step.agent);
    const agent = agents.get(step.agent);
    if (seen.has(step.id) || !agent || !allowed.has(step.agent)) return invalid();
    seen.add(step.id);
    return { id: step.id, agent };
  });
  const input = parse(inputJson, limits.maxInputBytes);
  safeInput(input);
  return freeze({ run: { steps, input, deadline: now + limits.timeoutMs }, limits });
}
