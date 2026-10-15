export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JobsClient = {
  start(definitionJson: string, inputJson: string): Promise<{ runId: number }>;
  status(runId: number): Promise<JsonValue>;
  cancel(runId: number): Promise<JsonValue>;
};

export type CliIO = {
  readFile(path: string): Promise<string>;
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
};

type Command = { kind: 'help' }
  | { kind: 'start'; definitionPath: string; inputPath?: string }
  | { kind: 'status' | 'cancel'; runId: number };

const usage = 'start <definition.json> [--input <input.json>]\nstatus <positive-safe-integer>\ncancel <positive-safe-integer>\nhelp\n';

function parse(argv: readonly string[]): Command {
  const [kind, argument] = argv;
  if (kind === 'help' && argv.length === 1) return { kind };
  if (kind === 'status' || kind === 'cancel') {
    if (argv.length === 2 && argument !== undefined && /^[1-9][0-9]*$/.test(argument)) {
      const runId = Number(argument);
      if (Number.isSafeInteger(runId)) return { kind, runId };
    }
  }
  if (kind === 'start' && argument && !argument.startsWith('-')) {
    if (argv.length === 2) return { kind, definitionPath: argument };
    const inputPath = argv[3];
    if (argv.length === 4 && argv[2] === '--input' && inputPath && !inputPath.startsWith('-')) {
      return { kind, definitionPath: argument, inputPath };
    }
  }
  throw new Error('invalid arguments');
}

/** Transport only. The injected client owns admission, ownership and native execution. */
export async function dispatchCli(argv: readonly string[], io: CliIO, jobs: JobsClient): Promise<number> {
  let code = 'invalid_arguments';
  let exitCode = 2;
  try {
    const command = parse(argv);
    if (command.kind === 'help') {
      code = 'output_failed';
      exitCode = 1;
      await io.stdout(usage);
      return 0;
    }
    let result: JsonValue;
    if (command.kind === 'start') {
      code = 'file_read_failed';
      exitCode = 1;
      const definitionJson = await io.readFile(command.definitionPath);
      const inputJson = command.inputPath === undefined ? 'null' : await io.readFile(command.inputPath);
      code = 'invalid_json';
      exitCode = 2;
      JSON.parse(definitionJson);
      JSON.parse(inputJson);
      code = 'jobs_failed';
      exitCode = 1;
      const started = await jobs.start(definitionJson, inputJson);
      if (!Number.isSafeInteger(started.runId) || started.runId <= 0) throw new Error('invalid run ID');
      result = { runId: started.runId };
    } else {
      code = 'jobs_failed';
      exitCode = 1;
      result = await jobs[command.kind](command.runId);
    }
    code = 'output_failed';
    const output = JSON.stringify(result);
    if (output === undefined) throw new Error('missing JSON result');
    await io.stdout(`${output}\n`);
    return 0;
  } catch {
    try { await io.stderr(`${JSON.stringify({ error: { code } })}\n`); }
    catch { return 1; }
    return exitCode;
  }
}
