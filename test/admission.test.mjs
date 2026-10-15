import assert from 'node:assert/strict';
import test from 'node:test';
import { admitDefinition } from '../src/admission.ts';

const definition = JSON.stringify({ version: 1, steps: [{ id: 'research', agent: 'researcher' }, { id: 'check', agent: 'checker' }] });
function policy() {
  const output = { validate() { throw new Error('Validator must not run'); }, succeeded() { throw new Error('Classifier must not run'); } };
  return {
    agents: ['researcher', 'checker'].map(name => ({
      instructions: 'Return JSON.', model: { modelId: 'local', provider: 'deterministic' },
      name, output, outputContractId: `${name}.output.v1`, implementationId: `${name}.v1`,
    })),
    allowedAgents: ['researcher', 'checker'],
    limits: { maxSteps: 4, maxInputBytes: 4096, maxRequests: 8, maxOutputTokens: 256, timeoutMs: 1000 },
  };
}
function frozen(value) {
  if (value !== null && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
  }
}
function rejects(def = definition, input = '{}', host = policy(), now = 100) {
  assert.throws(() => admitDefinition(def, input, host, now), { message: 'Invalid Jobs admission' });
}

test('ordered detached deeply frozen run, exact Stage snapshot order and no output callbacks', () => {
  const host = policy();
  const snapshots = host.agents.map(({ output, ...snapshot }) => snapshot);
  const admitted = admitDefinition(definition, '{"nested":[{"value":"seed"}]}', host, 100);
  assert.deepEqual(admitted, {
    run: { steps: [{ id: 'research', agent: snapshots[0] }, { id: 'check', agent: snapshots[1] }],
      input: { nested: [{ value: 'seed' }] }, deadline: 1100 }, limits: host.limits,
  });
  for (let i = 0; i < 2; i++) {
    assert.equal(JSON.stringify(admitted.run.steps[i].agent), JSON.stringify(snapshots[i]));
    assert.notEqual(admitted.run.steps[i].agent, host.agents[i]);
    assert.notEqual(admitted.run.steps[i].agent.model, host.agents[i].model);
  }
  assert.notEqual(admitted.limits, host.limits);
  frozen(admitted);
  host.agents[0].instructions = 'changed'; host.agents[0].model.modelId = 'changed';
  host.agents.reverse(); host.allowedAgents.length = 0; host.limits.timeoutMs = 1;
  assert.equal(admitted.run.steps[0].agent.instructions, 'Return JSON.');
  assert.equal(admitted.run.steps[0].agent.model.modelId, 'local');
  assert.equal(admitted.run.deadline, 1100);
  assert.equal(admitted.limits.timeoutMs, 1000);
  assert.throws(() => { admitted.run.input.nested[0].value = 'changed'; }, TypeError);
});

for (const input of ['null', 'true', '3.5', '"text"', '[1,2]']) {
  test(`admits JSON input ${input}`, () => assert.deepEqual(admitDefinition(definition, input, policy(), 0).run.input, JSON.parse(input)));
}

for (const bad of ['{', 'null', '[]', '{}', '{"version":2,"steps":[]}', '{"version":1,"steps":[]}',
  '{"version":1,"steps":{},"owner":1}',
  ...['owner', 'taskId', 'model', 'tools', 'cwd', 'capabilities'].map(key => JSON.stringify({ version: 1, steps: [{ id: 'a', agent: 'researcher' }], [key]: 'injected' })),
  ...[null, {}, { id: 'a', agent: 'missing' }, { id: 'a', agent: 'researcher', cwd: '/' },
    { id: '', agent: 'researcher' }, { id: '../x', agent: 'researcher' }, { id: 'a', agent: '' },
    { id: 'a', agent: { name: 'researcher' } }, { id: 1, agent: 'researcher' },
  ].map(step => JSON.stringify({ version: 1, steps: [step] })),
  JSON.stringify({ version: 1, steps: [{ id: 'a', agent: 'researcher' }, { id: 'a', agent: 'checker' }] }),
  JSON.stringify({ version: 1, steps: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, agent: 'researcher' })) }),
]) {
  test(`rejects definition ${bad}`, () => rejects(bad));
}

test('unknown properties inside step cannot inject authority', () => {
  for (const key of ['owner', 'taskIds', 'model', 'tools', 'cwd', 'capability', '__proto__']) {
    rejects(`{"version":1,"steps":[{"id":"a","agent":"researcher","${key}":{}}]}`);
  }
});

test('forbidden registered agent', () => {
  const host = policy(); host.allowedAgents = ['researcher']; rejects(definition, '{}', host);
});

test('byte bounds apply before JSON.parse to both documents including UTF-8', () => {
  const host = policy(); host.limits.maxInputBytes = Buffer.byteLength(definition);
  assert.ok(admitDefinition(definition, '{}', host, 0));
  rejects(`${definition} `, '{}', host);
  rejects(definition, ' '.repeat(4097));
  rejects(' '.repeat(4097));
  const multibyte = JSON.stringify('é'.repeat(2100));
  assert.ok(multibyte.length < 4096); rejects(definition, multibyte);
  const original = JSON.parse;
  JSON.parse = () => { assert.fail('oversized documents must never be parsed'); };
  try {
    rejects(' '.repeat(4097));
    let calls = 0;
    JSON.parse = json => {
      assert.equal(++calls, 1, 'only bounded definition may be parsed');
      return original(json);
    };
    rejects(definition, ' '.repeat(4097));
    assert.equal(calls, 1);
  } finally { JSON.parse = original; }
});

for (const bad of ['', '{', 'undefined', '1e400', '-1e400', '9007199254740992', '{"n":9007199254740993}',
  '{"__proto__":{"polluted":true}}', '{"nested":{"constructor":{}}}', '[{"prototype":1}]',
  '['.repeat(33) + '0' + ']'.repeat(33),
]) {
  test(`rejects unsafe input ${bad.slice(0, 70)}`, () => rejects(definition, bad));
}

test('depth 32 is admitted and 33 refused', () => {
  assert.ok(admitDefinition(definition, '['.repeat(32) + '0' + ']'.repeat(32), policy(), 0));
  rejects(definition, '['.repeat(33) + '0' + ']'.repeat(33));
});

for (const key of ['maxSteps', 'maxInputBytes', 'maxRequests', 'maxOutputTokens', 'timeoutMs']) {
  test(`rejects invalid explicit host cap ${key}`, () => {
    for (const value of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined, null]) {
      const host = policy(); host.limits[key] = value; rejects(definition, '{}', host);
    }
    const host = policy(); delete host.limits[key]; rejects(definition, '{}', host);
  });
}

test('rejects incompatible step cap, unknown/missing policy fields and malformed registry', () => {
  for (const change of [
    host => { host.limits.maxSteps = 65; },
    host => { host.limits.extra = 1; },
    host => { host.owner = 1; },
    host => { delete host.agents; },
    host => { host.agents = {}; },
    host => { host.allowedAgents = null; },
    host => { host.allowedAgents.push('missing'); },
    host => { host.allowedAgents.push('researcher'); },
    host => { host.agents.push(host.agents[0]); },
    host => { host.agents[0].tools = []; },
    host => { host.agents[0].name = ''; },
    host => { host.agents[0].implementationId = ''; },
    host => { host.agents[0].outputContractId = null; },
    host => { host.agents[0].instructions = ''; },
    host => { host.agents[0].model.provider = ''; },
    host => { host.agents[0].model.modelId = ''; },
    host => { host.agents[0].model.tools = []; },
    host => { host.agents[0].output = {}; },
    host => { Object.defineProperty(host.limits, 'maxRequests', { get() { throw new Error('should not execute'); }, enumerable: true }); },
  ]) {
    const host = policy(); change(host); rejects(definition, '{}', host);
  }
});

test('deadline uses original now and refuses unsafe time/overflow', () => {
  for (const now of [-1, 0.5, NaN, Infinity, '100', undefined, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => admitDefinition(definition, '{}', policy(), now), { message: 'Invalid Jobs admission' });
  }
  const host = policy(); host.limits.timeoutMs = 1;
  assert.equal(admitDefinition(definition, '{}', host, Number.MAX_SAFE_INTEGER - 1).run.deadline, Number.MAX_SAFE_INTEGER);
});

test('prototype output methods are recognized without being called or frozen', () => {
  class Contract {
    validate() { assert.fail('not during admission'); }
    succeeded() { assert.fail('not during admission'); }
  }
  const host = policy(); host.agents[0].output = new Contract();
  assert.ok(admitDefinition(definition, '{}', host, 0));
  assert.equal(Object.isFrozen(host.agents[0].output), false);
});
