import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_MIGRATIONS, SqliteStorage, type SqliteDatabase, type SqliteExecutor } from '@earendil-works/pi-durable/storage/sqlite';

// Pinned native schema, not a generic exporter or a runtime journal. Schema changes require review.
export const captureColumns = Object.freeze({
  durable_schema: 'singleton version', durable_metadata: 'singleton next_id next_seq', record_ids: 'id record_type',
  conversations: 'id owner_conversation_id owner_task_id record', entries: 'id conversation_id head commit_seq record',
  tasks: 'id conversation_id kind status abort_requested background record',
  submissions: 'id conversation_id request_id status record',
  documents: 'id kind family key_value scope_kind owner_id created_at retired_at record',
  document_revisions: 'document_id seq kind version content',
});
const normalize = (sql: string) => sql.replace(/IF NOT EXISTS\s+/i, '').replace(/\s+/g, ' ').trim();
const schemaVersionSQL = `CREATE TABLE durable_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version >= 0)
) STRICT`;
export const captureSchema: readonly { type: string; name: string; tbl_name: string; sql: string | null }[] = Object.freeze([
  schemaVersionSQL, ...SQLITE_MIGRATIONS.flatMap(m => m.statements).filter(sql => /^CREATE /i.test(sql)),
].map(sql => {
  const match = /^CREATE (TABLE|INDEX) (\w+)/i.exec(sql)!;
  return { type: match[1]!.toLowerCase(), name: match[2]!,
    tbl_name: match[1] === 'TABLE' ? match[2]! : /\bON\s+(\w+)/i.exec(sql)![1]!, sql: normalize(sql) as string | null };
}).concat([{ type: 'index', name: 'sqlite_autoindex_document_revisions_1', tbl_name: 'document_revisions', sql: null }]));

function cell(value: unknown): unknown {
  if (value === null) return ['null'];
  if (typeof value === 'string') return ['text', value];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'number' && Number.isFinite(value)) {
    const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return ['number-f64be', bytes.toString('hex')];
  }
  if (value instanceof Uint8Array) return ['blob-base64', Buffer.from(value).toString('base64')];
  throw new Error('unsupported_capture_cell');
}
function row(value: object, columns: readonly string[]) {
  if (!value || Object.keys(value).sort().join(' ') !== [...columns].sort().join(' ')) throw new Error('unexpected_capture_columns');
  return columns.map(column => [column, cell((value as Record<string, unknown>)[column])]);
}
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** ONLY the transaction handle is used here. All records, retired revisions, metadata and native receipts. */
export async function committedSnapshot(tx: SqliteExecutor) {
  if (CURRENT_SQLITE_SCHEMA_VERSION !== 1 || SQLITE_MIGRATIONS.length !== 1 ||
      captureSchema.filter(s => s.type === 'table').map(s => s.name).sort().join(' ') !== Object.keys(captureColumns).sort().join(' ')) {
    throw new Error('unsupported_capture_schema_version');
  }
  const schema = await tx.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name');
  const normalized = schema.map(s => {
    row(s, ['type', 'name', 'tbl_name', 'sql']);
    if (typeof s.type !== 'string' || typeof s.name !== 'string' || typeof s.tbl_name !== 'string' ||
        s.sql !== null && typeof s.sql !== 'string') throw new Error('unexpected_capture_schema');
    return { ...s, sql: s.sql === null ? null : normalize(s.sql) };
  });
  const sortSchema = (values: typeof normalized) => values.map(s => JSON.stringify([s.type, s.name, s.tbl_name, s.sql])).sort(lexical);
  if (JSON.stringify(sortSchema(normalized)) !== JSON.stringify(sortSchema([...captureSchema]))) throw new Error('unexpected_capture_schema');
  const rows: Record<string, unknown> = {};
  for (const [table, names] of Object.entries(captureColumns)) {
    const records = await tx.all(`SELECT * FROM ${table}`); // table names are fixed above, never operator SQL
    rows[table] = records.map(record => row(record, names.split(' '))).map(r => JSON.stringify(r)).sort(lexical).map(r => JSON.parse(r));
  }
  return { schema: schema.map(s => row(s, ['type', 'name', 'tbl_name', 'sql'])).map(r => JSON.stringify(r)).sort(lexical).map(r => JSON.parse(r)), rows };
}

async function identity(path: string, directory: boolean) {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.uid !== BigInt(process.geteuid!()) || (!directory && stat.nlink !== 1n) ||
      (directory && (stat.mode & 0o777n) !== 0o700n) || await realpath(path) !== path) throw new Error('unsafe_capture_physical_path');
  return { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), mode: String(stat.mode), nlink: String(stat.nlink) };
}
/** Existing private physical store root ONLY; rejects links/escape before opening any native adapter. */
export async function prepareNativeCapture(storePath: string, destination: string) {
  if (!isAbsolute(storePath) || !isAbsolute(destination) || resolve(storePath) !== storePath ||
      resolve(destination) !== destination || dirname(storePath) !== destination) throw new Error('invalid_capture_destination');
  const root = await identity(destination, true);
  // realpath equality rejects symlinks in ALL ancestors as well as the final component.
  let main;
  try { main = await identity(storePath, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return Object.freeze({ storePath, destination, root, main,
    path: join(destination, `logical-backup-${randomUUID()}.json`) });
}
export type CapturePlan = Awaited<ReturnType<typeof prepareNativeCapture>>;
export type CaptureReceipt = Readonly<{ path: string; sha256: string; bytes: number; committedSha256: string }>;

/** Public single-adapter facade: everything bound unchanged EXCEPT memoized capture-before-close.
 * Native Session and SqliteStorage have sealed admission/drained BEFORE they invoke this close.
 * Capture failure never calls the stock close, never retries, and never substitutes a new error.
 */
export function captureBeforeClose(db: SqliteDatabase, plan: CapturePlan, files: Pick<typeof import('node:fs/promises'), 'open'> = { open }) {
  let closing: Promise<void> | undefined;
  let receipt: CaptureReceipt | undefined;
  const checkPhysical = async () => {
    if (JSON.stringify(await identity(plan.destination, true)) !== JSON.stringify(plan.root)) throw new Error('capture_root_identity_changed');
    const main = await identity(plan.storePath, false);
    if (plan.main && JSON.stringify(main) !== JSON.stringify(plan.main)) throw new Error('capture_main_identity_changed');
    return main;
  };
  const database: SqliteDatabase = {
    exec: db.exec.bind(db), run: db.run.bind(db), get: db.get.bind(db), all: db.all.bind(db), transaction: db.transaction.bind(db),
    close() {
      closing ??= (async () => {
        const main = await checkPhysical();
        const committed = await db.transaction(tx => committedSnapshot(tx));
        const committedSha256 = createHash('sha256').update(JSON.stringify(committed)).digest('hex');
        const data = JSON.stringify({ format: 'durable-jobs-logical-backup-v1', authoritative: false,
          physical: { rootPath: plan.destination, databasePath: plan.storePath, root: plan.root, main }, committed, committedSha256 }) + '\n';
        await checkPhysical();
        const file = await files.open(plan.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        // Preserve the FIRST write/sync error even if closing the evidence descriptor also fails.
        let failed = false;
        let writtenIdentity: { dev: bigint; ino: bigint } | undefined;
        try {
          await file.writeFile(data, 'utf8'); await file.sync();
          writtenIdentity = await file.stat({ bigint: true });
        }
        catch (error) { failed = true; throw error; }
        finally { try { await file.close(); } catch (error) { if (!failed) throw error; } }
        const evidence = await identity(plan.path, false);
        if (BigInt(evidence.mode) % 0o1000n !== 0o600n || evidence.dev !== String(writtenIdentity!.dev) ||
            evidence.ino !== String(writtenIdentity!.ino)) throw new Error('unsafe_capture_file_identity');
        const directory = await files.open(plan.destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        failed = false;
        try { await directory.sync(); } catch (error) { failed = true; throw error; }
        finally { try { await directory.close(); } catch (error) { if (!failed) throw error; } }
        await checkPhysical();
        receipt = Object.freeze({ path: plan.path, sha256: createHash('sha256').update(data).digest('hex'),
          bytes: Buffer.byteLength(data), committedSha256 });
        await db.close(); // unchanged stock checkpoint/native cleanup, after retained complete backup
      })();
      return closing;
    },
  };
  return { database, receipt: () => receipt };
}
/** Called ONLY inside the acquired owner factory. Exactly ONE stock connection, no SDK patch. */
export async function openCapturedSqliteStorage(plan: CapturePlan, captured: (get: () => CaptureReceipt | undefined) => void) {
  const { openNodeSqliteDatabase } = await import('@earendil-works/pi-durable/storage/sqlite/node');
  const db = await openNodeSqliteDatabase(plan.storePath);
  const facade = captureBeforeClose(db, plan);
  captured(facade.receipt);
  return SqliteStorage.open(facade.database);
}
