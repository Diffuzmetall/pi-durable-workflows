#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dispatchCli } from '../src/cli.ts';
import { IPCJobsClient } from '../src/ipc.ts';

process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
const write = stream => text => new Promise((resolve, reject) => {
  stream.write(text, error => error ? reject(error) : resolve());
});
// Lazy connection/configuration: help, invalid args and malformed files have no transport/provider/DB effects.
const call = (method, ...args) => {
  const client = new IPCJobsClient({ storePath: process.env.DURABLE_JOBS_STORE,
    secret: process.env.DURABLE_JOBS_SECRET });
  return client[method](...args);
};
process.exitCode = await dispatchCli(process.argv.slice(2), {
  readFile: path => readFile(path, 'utf8'), stdout: write(process.stdout), stderr: write(process.stderr),
}, { start: (...args) => call('start', ...args), status: id => call('status', id), cancel: id => call('cancel', id) });
