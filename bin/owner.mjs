#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
const write = (stream, text) => new Promise((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve()));
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === 'help') {
  try { await write(process.stdout, 'owner <trusted-host.json>\nEnvironment: DURABLE_JOBS_STORE (absolute path), DURABLE_JOBS_SECRET (>=32 characters).\nOptional DURABLE_JOBS_LOGICAL_BACKUP_DIR: existing private physical store directory; retained pre-close logical backup.\nForeground only. SIGINT/SIGTERM requests shutdown; no automatic daemon.\n'); } catch { process.exitCode = 1; }
} else if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
  process.exitCode = 2;
  try { await write(process.stderr, '{"error":{"code":"invalid_arguments"}}\n'); } catch { process.exitCode = 1; }
} else {
  let owner;
  let stopping;
  let requested = false;
  const stop = () => {
    requested = true;
    if (!owner || stopping) return;
    stopping = Promise.resolve().then(() => owner.close()).catch(async () => {
      process.exitCode = 1;
      try { await write(process.stderr, '{"error":{"code":"host_shutdown_failed","ownershipRetained":true}}\n'); } catch {}
      // Listener remains reserved. Diagnostic rejection cannot terminate this potential owner.
      // No process.exit, automatic retry or false successful cleanup.
    });
    stopping = stopping.finally(async () => {
      const receipt = owner.captureReceipt?.();
      if (receipt) {
        try { await write(process.stdout, JSON.stringify({ logicalBackup: receipt }) + '\n'); }
        catch { process.exitCode = 1; } // evidence remains private on disk; never retry native close
      }
    });
    void stopping.catch(() => {}); // observe ALL shutdown/diagnostic failures, including a synchronous close throw
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    // SDK/native imports are deferred until after help/argument handling. No JS config/module selector.
    const { parseHostConfig, openConfiguredJobsHost } = await import('../src/host.ts');
    const config = parseHostConfig(await readFile(args[0], 'utf8'));
    if (!process.env.DURABLE_JOBS_STORE || !process.env.DURABLE_JOBS_SECRET) throw new Error('missing_ipc_config');
    if (!requested) {
      owner = await openConfiguredJobsHost({ storePath: process.env.DURABLE_JOBS_STORE,
        secret: process.env.DURABLE_JOBS_SECRET }, config, process.env.DURABLE_JOBS_LOGICAL_BACKUP_DIR);
      await write(process.stdout, JSON.stringify({ startup: owner.startup, foreground: true }) + '\n');
      if (requested) stop();
      // Real TCP listener keeps this process alive until real backend cleanup has settled.
    }
  } catch {
    process.exitCode = 1;
    try { await write(process.stderr, '{"error":{"code":"host_start_failed"}}\n'); } catch {}
    if (owner) stop();
    else { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
}
