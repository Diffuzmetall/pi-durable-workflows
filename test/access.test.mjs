import assert from 'node:assert/strict';
import test from 'node:test';

const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
const { Harness, MemoryStorage, createRegistry, defineExtension, defineTask } = await import('@earendil-works/pi-durable');
const { createModels } = await import('@earendil-works/pi-ai');
const { getOwnedRun, cancelOwnedRun, RunNotFound } = await import('../src/access.ts');

test('native owner read/cancel guard hides foreign records and never resumes', async () => {
  let calls = 0;
  const Task = defineTask({ name: 'jobs.run', version: 1, initial: () => ({ phase: 'prepare' }),
    phases: { prepare() { calls++; throw new Error('must stay paused'); } },
    abort() { calls++; throw new Error('must stay paused'); } });
  const Other = defineTask({ name: 'other', version: 1, initial: () => ({ phase: 'prepare' }), phases: { prepare() { calls++; } } });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'access-fixture', tasks: [Task, Other] }));
  const harness = await Harness.open(new MemoryStorage(), { registry, models: createModels() }, context);
  try {
    const owner = await harness.root(context);
    const foreign = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    const ids = await harness.commit(async tx => {
      const own = await tx.createTask(Task, {}, { ownership: { kind: 'conversation' }, conversationId: owner.id, background: true });
      const other = await tx.createTask(Task, { secret: 'foreign' }, { ownership: { kind: 'conversation' }, conversationId: foreign.id, background: true });
      const ordinary = await tx.createTask(Task, {}, { ownership: { kind: 'conversation' }, conversationId: owner.id });
      const wrongKind = await tx.createTask(Other, {}, { ownership: { kind: 'conversation' }, conversationId: owner.id, background: true });
      const child = await tx.createTask(Task, {}, { ownership: { kind: 'task', taskId: own } });
      return { own, other, ordinary, wrongKind, child };
    }, context);
    assert.equal((await getOwnedRun(harness, owner.id, ids.own, context)).id, ids.own);
    for (const id of [ids.other, ids.ordinary, ids.wrongKind, ids.child, 999999, -1, NaN]) {
      await assert.rejects(getOwnedRun(harness, owner.id, id, context), error => error instanceof RunNotFound && error.message === 'Run not found' && !('run' in error));
      await assert.rejects(cancelOwnedRun(harness, owner.id, id, context), RunNotFound);
    }
    await assert.rejects(getOwnedRun(harness, { ownerConversationId: foreign.id }, ids.other, context), RunNotFound);
    assert.equal((await harness.getTask(ids.other, context)).abortRequested, false);
    assert.equal(await cancelOwnedRun(harness, owner.id, ids.own, context), 'marked');
    assert.equal((await harness.getTask(ids.own, context)).abortRequested, true);
    assert.equal((await harness.inspect(context)).scheduling, 'paused');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  } finally { await harness.close(context); }
});
