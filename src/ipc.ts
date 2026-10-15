import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import type { JobsClient, JsonValue } from './cli.ts';

const HOST = '127.0.0.1';
const MAX_FRAME = 1024 * 1024;
const MAX_ENVELOPE = MAX_FRAME / 2;
const AES_GCM_OVERHEAD = 12 + 16; // IV + authentication tag; ciphertext length equals plaintext length.
const TIMEOUT = 5000;
const MAX_CONNECTIONS = 32;
const MAX_HANDLERS = 32;
export type IPCConfig = { storePath: string; secret: string; timeoutMs?: number };
export type IPCEndpoint = { host: '127.0.0.1'; port: number; store: string };
export type IPCBackend = { client: JobsClient; close(): Promise<void> };

export class IPCError extends Error {
  readonly code: 'ipc_failed' | 'ipc_unknown_result' | 'ipc_config' | 'ipc_owner_failed';
  constructor(code: IPCError['code']) { super(code); this.name = 'IPCError'; this.code = code; }
}

/** Only canonical, stable host paths are supported. No symlink/hardlink aliases,
 * configurable ports, fallback listeners, or claim of an OS-wide file lock.
 * The trusted host must keep the path/parent stable and use this owner gate for
 * every opener of the store in the same host/network namespace. Bind-mount
 * aliases and concurrent path replacement are outside this host contract.
 * Nonparticipating DB openers cannot be prevented; this is not global flock.
 */
export async function resolveIPCEndpoint(storePath: string): Promise<IPCEndpoint> {
  try {
    if (!isAbsolute(storePath) || normalize(storePath) !== storePath) throw 0;
    if (await realpath(dirname(storePath)) !== dirname(storePath)) throw 0;
    try {
      const stat = await lstat(storePath);
      if (!stat.isFile() || stat.nlink !== 1 || await realpath(storePath) !== storePath) throw 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    const store = createHash('sha256').update(storePath).digest('hex');
    return Object.freeze({ host: HOST, port: 20000 + (parseInt(store.slice(0, 8), 16) % 40000), store });
  } catch { throw new IPCError('ipc_config'); }
}

function settings(config: IPCConfig): { secret: string; timeout: number } {
  if (!config || Object.getPrototypeOf(config) !== Object.prototype || Object.keys(config).some(key => !['storePath', 'secret', 'timeoutMs'].includes(key))) throw new IPCError('ipc_config');
  if (typeof config.secret !== 'string' || Buffer.byteLength(config.secret) < 32 || Buffer.byteLength(config.secret) > 1024) throw new IPCError('ipc_config');
  const timeout = config.timeoutMs ?? TIMEOUT;
  if (!Number.isSafeInteger(timeout) || timeout < 20 || timeout > 30000) throw new IPCError('ipc_config');
  return { secret: config.secret, timeout };
}
function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw 0;
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw 0;
}
function hex(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw 0;
}
function id(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw 0;
}
function json(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 64) throw 0;
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const item of value) json(item, depth + 1); return; }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw 0;
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw 0;
    json(item, depth + 1);
  }
}
function mac(secret: string, role: string, store: string, client: string, server: string): string {
  return createHmac('sha256', secret).update(JSON.stringify(['jobs-ipc-1', role, store, client, server])).digest('hex');
}
function equal(actual: unknown, expected: string): void {
  hex(actual);
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) throw 0;
}
// Distinct directional keys and one encrypted message per direction; random IVs.
// Encryption also prevents a malicious listener relaying authentication to read
// private payloads. No secret or private JSON is sent to an unverified listener.
function seal(key: string, value: unknown): string {
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.length > MAX_ENVELOPE) throw 0;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
function unseal(key: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil((MAX_ENVELOPE + AES_GCM_OVERHEAD) / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw 0;
  const bytes = Buffer.from(value, 'base64');
  // Bound the decoded envelope BEFORE decrypting: native GCM adds only the
  // 12-byte IV and 16-byte tag used by seal(), with no ciphertext padding.
  if (bytes.length < AES_GCM_OVERHEAD || bytes.length > MAX_ENVELOPE + AES_GCM_OVERHEAD || bytes.toString('base64') !== value) throw 0;
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  if (plaintext.length > MAX_ENVELOPE) throw 0;
  return JSON.parse(plaintext.toString('utf8'));
}

/** One outstanding frame, never an unbounded queue. Absolute deadline (not an
 * inactivity timer) bounds slow senders; rejecting a frame destroys the socket.
 */
function channel(socket: Socket, timeout: number) {
  let buffer = Buffer.alloc(0);
  let waiting: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let failure: Error | undefined;
  const fail = () => {
    if (!failure) failure = new IPCError('ipc_failed');
    waiting?.reject(failure); waiting = undefined;
    socket.destroy();
  };
  const timer = setTimeout(fail, timeout);
  socket.on('error', fail);
  socket.on('end', fail);
  socket.on('close', () => { clearTimeout(timer); fail(); });
  socket.on('data', chunk => {
    try {
      if (!waiting || buffer.length + chunk.length > MAX_FRAME + 4) throw 0;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32BE(0);
      if (size === 0 || size > MAX_FRAME) throw 0;
      if (buffer.length < size + 4) return;
      // No pipelining, trailing bytes, or second request per connection.
      if (buffer.length !== size + 4) throw 0;
      const value: unknown = JSON.parse(buffer.subarray(4).toString('utf8'));
      const receiver = waiting; waiting = undefined; buffer = Buffer.alloc(0);
      receiver.resolve(value);
    } catch { fail(); }
  });
  return {
    read(): Promise<unknown> {
      if (failure || waiting) return Promise.reject(new IPCError('ipc_failed'));
      const pending = new Promise<unknown>((resolve, reject) => { waiting = { resolve, reject }; });
      // A synchronous send/encoding failure can abandon the read; still consume
      // its rejection while preserving it for the normal awaiting caller.
      void pending.catch(() => {});
      return pending;
    },
    send(value: unknown): void {
      if (failure || socket.destroyed) throw new IPCError('ipc_failed');
      const body = Buffer.from(JSON.stringify(value));
      if (body.length === 0 || body.length > MAX_FRAME) throw new IPCError('ipc_failed');
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
      socket.write(Buffer.concat([prefix, body]));
    },
    close(): void { clearTimeout(timer); socket.destroy(); },
  };
}

function request(value: unknown): { method: 'start'; definitionJson: string; inputJson: string } | { method: 'status' | 'cancel'; runId: number } {
  if (value === null || typeof value !== 'object') throw 0;
  const method = (value as Record<string, unknown>).method;
  if (method === 'start') {
    record(value, ['method', 'definitionJson', 'inputJson']);
    if (typeof value.definitionJson !== 'string' || typeof value.inputJson !== 'string') throw 0;
    if (value.definitionJson.length + value.inputJson.length > MAX_ENVELOPE
      || Buffer.byteLength(value.definitionJson) + Buffer.byteLength(value.inputJson) > MAX_ENVELOPE) throw 0;
    // Validate JSON without changing exact original strings. Service owns admission.
    json(JSON.parse(value.definitionJson)); json(JSON.parse(value.inputJson));
    return { method, definitionJson: value.definitionJson, inputJson: value.inputJson };
  }
  if (method !== 'status' && method !== 'cancel') throw 0;
  record(value, ['method', 'runId']); id(value.runId);
  return { method, runId: value.runId };
}

export class IPCJobsClient implements JobsClient {
  readonly #config: IPCConfig;
  constructor(config: IPCConfig) { settings(config); this.#config = { ...config }; }
  async start(definitionJson: string, inputJson: string): Promise<{ runId: number }> {
    const result = await this.#call({ method: 'start', definitionJson, inputJson });
    try { record(result, ['runId']); id(result.runId); return { runId: result.runId }; }
    catch { throw new IPCError('ipc_unknown_result'); }
  }
  status(runId: number): Promise<JsonValue> { return this.#call({ method: 'status', runId }); }
  cancel(runId: number): Promise<JsonValue> { return this.#call({ method: 'cancel', runId }); }
  async #call(args: unknown): Promise<JsonValue> {
    let sent = false;
    let knownFailure = false;
    let wire: ReturnType<typeof channel> | undefined;
    try {
      request(args);
      const { secret, timeout } = settings(this.#config);
      const endpoint = await resolveIPCEndpoint(this.#config.storePath);
      const socket = createConnection({ host: HOST, port: endpoint.port });
      wire = channel(socket, timeout);
      const client = randomBytes(32).toString('hex');
      const helloPromise = wire.read();
      wire.send({ v: 1, store: endpoint.store, nonce: client });
      const hello = await helloPromise;
      record(hello, ['nonce', 'proof']); hex(hello.nonce);
      equal(hello.proof, mac(secret, 'server', endpoint.store, client, hello.nonce));
      const responsePromise = wire.read();
      const data = seal(mac(secret, 'request', endpoint.store, client, hello.nonce), args);
      // From here, a missing reply may mean an effect happened. Never retry.
      sent = true;
      wire.send({ proof: mac(secret, 'client', endpoint.store, client, hello.nonce), data });
      const encrypted = await responsePromise;
      record(encrypted, ['data']);
      const response = unseal(mac(secret, 'response', endpoint.store, client, hello.nonce), encrypted.data);
      if (response !== null && typeof response === 'object' && (response as Record<string, unknown>).ok === true) {
        record(response, ['ok', 'value']); json(response.value); return response.value;
      }
      record(response, ['ok', 'error']);
      if (response.ok !== false || response.error !== 'jobs_failed') throw 0;
      knownFailure = true;
      throw new IPCError('ipc_failed');
    } catch {
      throw new IPCError(sent && !knownFailure ? 'ipc_unknown_result' : 'ipc_failed');
    } finally { wire?.close(); }
  }
}

/** Reserve the only deterministic listener BEFORE opening any native backend.
 * Backend is trusted host code, never selected by request JSON. The host must
 * close its Harness in backend.close(), and clean partial opens before rejecting
 * the factory. A failed backend close retains the reservation (fail closed).
 */
export async function createIPCJobsOwner(config: IPCConfig, openBackend: () => Promise<IPCBackend>): Promise<{ endpoint: IPCEndpoint; close(): Promise<void> }> {
  const { secret, timeout } = settings(config);
  const endpoint = await resolveIPCEndpoint(config.storePath);
  const sockets = new Set<Socket>();
  let backend: IPCBackend | undefined;
  let closing = false;
  // Global across this owner's connections/methods, independent of socket life.
  // No queue: EOF/deadline does NOT free a permit held by unfinished host code.
  let activeHandlers = 0;
  const server = createServer(socket => {
    if (!backend || closing || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const wire = channel(socket, timeout);
    void (async () => {
      try {
        const hello = await wire.read();
        record(hello, ['v', 'store', 'nonce']); hex(hello.nonce);
        if (hello.v !== 1 || hello.store !== endpoint.store) throw 0;
        const client = hello.nonce;
        const nonce = randomBytes(32).toString('hex');
        const authPromise = wire.read();
        wire.send({ nonce, proof: mac(secret, 'server', endpoint.store, client, nonce) });
        const auth = await authPromise;
        record(auth, ['proof', 'data']);
        equal(auth.proof, mac(secret, 'client', endpoint.store, client, nonce));
        const args = request(unseal(mac(secret, 'request', endpoint.store, client, nonce), auth.data));
        if (closing || socket.destroyed || activeHandlers >= MAX_HANDLERS) throw 0;
        activeHandlers++;
        let response: unknown;
        try {
          const value = args.method === 'start'
            ? await backend!.client.start(args.definitionJson, args.inputJson)
            : await backend!.client[args.method](args.runId);
          json(value);
          if (args.method === 'start') { record(value, ['runId']); id(value.runId); }
          response = { ok: true, value };
        } catch { response = { ok: false, error: 'jobs_failed' }; }
        finally { activeHandlers--; }
        wire.send({ data: seal(mac(secret, 'response', endpoint.store, client, nonce), response) });
        socket.end();
      } catch { wire.close(); }
    })();
  });
  // No reusePort, alternate endpoint, ownership file, or filesystem mutation.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: HOST, port: endpoint.port, exclusive: true, backlog: MAX_CONNECTIONS }, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch { throw new IPCError('ipc_owner_failed'); }
  server.on('error', () => { closing = true; for (const socket of sockets) socket.destroy(); });
  const closeListener = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(new IPCError('ipc_owner_failed')) : resolve()));
  try { backend = await openBackend(); }
  catch {
    closing = true;
    for (const socket of sockets) socket.destroy();
    await closeListener();
    throw new IPCError('ipc_owner_failed');
  }
  let shutdown: Promise<void> | undefined;
  return {
    endpoint,
    async close(): Promise<void> {
      closing = true;
      for (const socket of sockets) socket.destroy();
      if (!shutdown) {
        shutdown = (async () => { await backend!.close(); await closeListener(); })();
        // Retry a rejected shutdown only on another explicit close(). If it is
        // merely slow, join it; never release the reservation ahead of Harness.
        void shutdown.catch(() => { shutdown = undefined; });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          shutdown,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new IPCError('ipc_owner_failed')), timeout); }),
        ]);
      } catch { throw new IPCError('ipc_owner_failed'); }
      finally { if (timer) clearTimeout(timer); }
    },
  };
}
