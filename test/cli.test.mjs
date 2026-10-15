import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dispatchCli } from '../src/cli.ts';

function fixture(files = {}, overrides = {}) {
  const calls = [];
  const reads = [];
  const out = [];
  const err = [];
  const jobs = {
    async start(...args) { calls.push(['start', ...args]); return { runId: 17 }; },
    async status(id) { calls.push(['status', id]); return { runId: id, state: 'running', step: 'research' }; },
    async cancel(id) { calls.push(['cancel', id]); return { runId: id, state: 'cancelled' }; },
    ...overrides,
  };
  const io = {
    async readFile(path) { reads.push(path); if (!(path in files)) throw new Error('PRIVATE missing path'); return files[path]; },
    stdout(text) { out.push(text); },
    stderr(text) { err.push(text); },
  };
  return { calls, reads, out, err, jobs, io };
}

const definition = '{"version":1,"steps":[{"id":"research","agent":"researcher"}]}';

test('unit: start forwards exact definition and separate input, defaulting to JSON null', async () => {
  for (const explicit of [false, true]) {
    const f = fixture({ 'definition.json': definition, 'input.json': ' {"topic":"local"}\n' });
    const argv = ['start', 'definition.json', ...(explicit ? ['--input', 'input.json'] : [])];
    assert.equal(await dispatchCli(argv, f.io, f.jobs), 0);
    assert.deepEqual(f.out, ['{"runId":17}\n']);
    assert.deepEqual(f.err, []);
    assert.deepEqual(f.calls, [['start', definition, explicit ? ' {"topic":"local"}\n' : 'null']]);
    assert.deepEqual(f.reads, explicit ? ['definition.json', 'input.json'] : ['definition.json']);
  }
});

test('unit: status and cancel emit client JSON with exact safe ID', async () => {
  for (const command of ['status', 'cancel']) {
    const f = fixture();
    assert.equal(await dispatchCli([command, '9007199254740991'], f.io, f.jobs), 0);
    assert.deepEqual(f.calls, [[command, 9007199254740991]]);
    assert.deepEqual(JSON.parse(f.out[0]), command === 'status'
      ? { runId: 9007199254740991, state: 'running', step: 'research' }
      : { runId: 9007199254740991, state: 'cancelled' });
    assert.deepEqual(f.err, []);
  }
});

test('unit: help is available without reading files or calling backend', async () => {
  const f = fixture();
  assert.equal(await dispatchCli(['help'], f.io, f.jobs), 0);
  assert.match(f.out[0], /^start <definition.json> \[--input <input.json>\]\nstatus/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.reads, []);
});

test('unit: malformed commands and noncanonical or unsafe IDs fail before transport', async () => {
  const commands = [[], ['unknown'], ['--help'], ['help', 'extra'], ['start'], ['start', '--input'],
    ['start', 'd', '--unknown'], ['start', 'd', '--input'], ['start', 'd', '--input', '--flag'],
    ['start', 'd', '--input', 'i', 'extra'], ['start', 'd', 'extra'], ['start', '', '--input', 'i']];
  for (const cmd of ['status', 'cancel']) {
    commands.push([cmd], [cmd, '1', 'extra']);
    for (const id of ['0', '-1', '+1', '01', '1.0', '1e2', ' 1', '1 ', 'NaN', 'Infinity', '9007199254740992', '']) {
      commands.push([cmd, id]);
    }
  }
  for (const argv of commands) {
    const f = fixture();
    assert.equal(await dispatchCli(argv, f.io, f.jobs), 2, JSON.stringify(argv));
    assert.deepEqual(f.out, []);
    assert.deepEqual(f.err, ['{"error":{"code":"invalid_arguments"}}\n']);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.calls, []);
  }
});

test('unit: missing files and malformed JSON produce bounded errors without dispatch', async () => {
  for (const [files, argv, code, exit] of [
    [{}, ['start', 'missing'], 'file_read_failed', 1],
    [{ d: definition }, ['start', 'd', '--input', 'missing'], 'file_read_failed', 1],
    [{ d: '{' }, ['start', 'd'], 'invalid_json', 2],
    [{ d: definition, i: 'undefined' }, ['start', 'd', '--input', 'i'], 'invalid_json', 2],
  ]) {
    const f = fixture(files);
    assert.equal(await dispatchCli(argv, f.io, f.jobs), exit);
    assert.deepEqual(f.err, [`{"error":{"code":"${code}"}}\n`]);
    assert.deepEqual(f.out, []);
    assert.deepEqual(f.calls, []);
  }
});

test('unit: semantic admission and unknown run failures stay client-owned and visible', async () => {
  for (const command of ['start', 'status', 'cancel']) {
    const f = fixture({ d: '{"version":99}' }, {
      async [command]() { throw new Error('PRIVATE permission/owner/unknown run'); },
    });
    assert.equal(await dispatchCli(command === 'start' ? ['start', 'd'] : [command, '7'], f.io, f.jobs), 1);
    assert.deepEqual(f.err, ['{"error":{"code":"jobs_failed"}}\n']);
    assert.deepEqual(f.out, []);
  }
});

test('unit: invalid start response and output failures never report success or leak details', async () => {
  for (const runId of [0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1, undefined]) {
    const f = fixture({ d: definition }, { async start() { return { runId }; } });
    assert.equal(await dispatchCli(['start', 'd'], f.io, f.jobs), 1);
    assert.deepEqual(f.err, ['{"error":{"code":"jobs_failed"}}\n']);
    assert.deepEqual(f.out, []);
  }
  const f = fixture();
  f.io.stdout = async () => { throw new Error('PRIVATE broken writer'); };
  assert.equal(await dispatchCli(['status', '7'], f.io, f.jobs), 1);
  assert.deepEqual(f.err, ['{"error":{"code":"output_failed"}}\n']);
  f.io.stderr = async () => { throw new Error('PRIVATE broken error writer'); };
  assert.equal(await dispatchCli(['status', '7'], f.io, f.jobs), 1);
});

test('unit: async stdout rejection after successful start retains one mutation and awaits failure', async () => {
  const events = [];
  let run = null;
  const f = fixture({ d: definition });
  f.jobs.start = async (...args) => {
    f.calls.push(['start', ...args]);
    run = { runId: 17, state: 'running' };
    events.push('started');
    return { runId: 17 };
  };
  f.io.stdout = async text => {
    assert.equal(text, '{"runId":17}\n');
    await new Promise(resolve => setImmediate(resolve));
    events.push('stdout-rejected');
    throw new Error('PRIVATE async output failure after start');
  };
  f.io.stderr = text => { f.err.push(text); events.push('error-reported'); };
  const exit = await dispatchCli(['start', 'd'], f.io, f.jobs);
  events.push('dispatch-completed');
  assert.equal(exit, 1);
  assert.deepEqual(f.calls, [['start', definition, 'null']]);
  assert.deepEqual(run, { runId: 17, state: 'running' });
  assert.deepEqual(f.err, ['{"error":{"code":"output_failed"}}\n']);
  assert.deepEqual(f.out, []);
  assert.deepEqual(events, ['started', 'stdout-rejected', 'error-reported', 'dispatch-completed']);
});

test('unit: async stdout rejection after successful cancel retains one mutation and awaits failure', async () => {
  const events = [];
  const run = { runId: 17, state: 'running' };
  const f = fixture();
  f.jobs.cancel = async id => {
    f.calls.push(['cancel', id]);
    run.state = 'cancelled';
    events.push('cancelled');
    return { ...run };
  };
  f.io.stdout = async text => {
    assert.equal(text, '{"runId":17,"state":"cancelled"}\n');
    await new Promise(resolve => setImmediate(resolve));
    events.push('stdout-rejected');
    throw new Error('PRIVATE async output failure after cancel');
  };
  f.io.stderr = text => { f.err.push(text); events.push('error-reported'); };
  const exit = await dispatchCli(['cancel', '17'], f.io, f.jobs);
  events.push('dispatch-completed');
  assert.equal(exit, 1);
  assert.deepEqual(f.calls, [['cancel', 17]]);
  assert.deepEqual(run, { runId: 17, state: 'cancelled' });
  assert.deepEqual(f.err, ['{"error":{"code":"output_failed"}}\n']);
  assert.deepEqual(f.out, []);
  assert.deepEqual(events, ['cancelled', 'stdout-rejected', 'error-reported', 'dispatch-completed']);
});

test('unit: dispatcher awaits asynchronous writers and preserves JSON null', async () => {
  const f = fixture({}, { async status() { return null; } });
  f.io.stdout = async text => {
    await new Promise(resolve => setImmediate(resolve));
    f.out.push(text);
  };
  assert.equal(await dispatchCli(['status', '7'], f.io, f.jobs), 0);
  assert.deepEqual(f.out, ['null\n']);
  assert.deepEqual(f.err, []);
  for (const invalid of [undefined, 7n, (() => { const value = {}; value.self = value; return value; })()]) {
    const bad = fixture({}, { async status() { return invalid; } });
    assert.equal(await dispatchCli(['status', '7'], bad.io, bad.jobs), 1);
    assert.deepEqual(bad.err, ['{"error":{"code":"output_failed"}}\n']);
    assert.deepEqual(bad.out, []);
  }
});

test('unit: stdlib reader forwards researcher/checker/final example, not native CLI E2E', async () => {
  const out = [];
  const seen = [];
  const path = new URL('../examples/research-check-final.json', import.meta.url).pathname;
  const jobs = { async start(def, input) { seen.push([JSON.parse(def), input]); return { runId: 23 }; } };
  assert.equal(await dispatchCli(['start', path], {
    readFile: p => readFile(p, 'utf8'), stdout: text => { out.push(text); }, stderr: () => assert.fail('unexpected error'),
  }, jobs), 0);
  assert.deepEqual(seen, [[{ version: 1, steps: [
    { id: 'research', agent: 'researcher' }, { id: 'check', agent: 'checker' }, { id: 'final', agent: 'final' },
  ] }, 'null']]);
  assert.deepEqual(out, ['{"runId":23}\n']);
});
