import crypto from 'crypto';
import path from 'path';

import type { PlaywrightTestConfig, ReporterDescription } from '@playwright/test';

/**
 * Environment variable through which the appwright CLI (or the first process that calls
 * `resolveRunName`) tells every other process of a run which name the run has.
 *
 * Playwright evaluates the config file again inside every worker process, so the name is stored
 * here once and re-read everywhere instead of being generated again per process.
 */
export const RUN_NAME_ENV = 'APPWRIGHT_RUN_NAME';

/**
 * Environment variable through which `defineConfig` publishes the run's resolved Playwright
 * `outputDir` to the rest of appwright, so that folders derived from it (the video store) follow a
 * custom `outputDir` instead of assuming the default base.
 */
export const OUTPUT_DIR_ENV = 'APPWRIGHT_OUTPUT_DIR';

/** Playwright's default `outputDir`; per-run folders are nested under it. */
export const DEFAULT_OUTPUT_DIR = 'test-results';
/** The html reporter's default `outputFolder`; per-run folders are nested under it. */
export const DEFAULT_REPORT_DIR = 'playwright-report';
/** The blob reporter's default `outputDir`; per-run folders are nested under it. */
export const DEFAULT_BLOB_DIR = 'blob-report';
/** Sub-folder of the run's output dir that holds worker videos and worker-info files. */
export const VIDEOS_STORE_DIR = 'videos-store';

export const RUN_NAME_FLAG = '--run-name';
const PROJECT_FLAG = '--project';

/**
 * Characters allowed in a run name. Everything else is replaced with `-` so the name is always a
 * safe single path segment on every OS. `+` is kept so several projects can be joined as `a+b`.
 */
const DISALLOWED_CHARS = /[^A-Za-z0-9._+-]+/g;

const SUFFIX_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

type FlagValues = { values: string[]; rest: string[] };

/**
 * Removes every `<flag> value` / `<flag>=value` occurrence from `argv`. Throws when the flag is
 * present without a value (a following argument that starts with `-` does not count as a value).
 */
function takeFlag(argv: readonly string[], flag: string, missingValueMessage: string): FlagValues {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(missingValueMessage);
      }
      values.push(next);
      i++;
    } else if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (value === '') {
        throw new Error(missingValueMessage);
      }
      values.push(value);
    } else {
      rest.push(arg);
    }
  }
  return { values, rest };
}

/**
 * Names of the projects selected with `--project` on the command line. Playwright does not expose
 * the selection to the config or to `process.env`, so it is read from argv (the same way
 * globalSetup has always done it).
 */
export function parseProjectsFromArgv(argv: readonly string[]): string[] {
  return takeFlag(argv, PROJECT_FLAG, `Project name is required with ${PROJECT_FLAG} flag`).values;
}

/**
 * Splits `--run-name <name>` (or `--run-name=<name>`) out of the CLI arguments. `rest` is argv
 * without the flag, ready to be handed to Playwright, which rejects unknown options.
 */
export function extractRunNameArg(argv: readonly string[]): { runName?: string; rest: string[] } {
  const { values, rest } = takeFlag(
    argv,
    RUN_NAME_FLAG,
    `${RUN_NAME_FLAG} requires a value, e.g. \`${RUN_NAME_FLAG} nightly\``,
  );
  const runName = values.length > 0 ? values[values.length - 1] : undefined;
  return runName === undefined ? { rest } : { runName, rest };
}

/**
 * Makes a run name safe to use as a folder name: trims it, replaces disallowed characters with
 * `-`, and strips leading dots (so `..` can never escape the output folder).
 */
export function sanitizeRunName(raw: string): string {
  const cleaned = raw.trim().replace(DISALLOWED_CHARS, '-').replace(/^\.+/, '');
  if (cleaned === '') {
    throw new Error(
      `Run name "${raw}" contains no usable characters. Use letters, digits, ".", "_" or "-".`,
    );
  }
  return cleaned;
}

/** `length` random lowercase base36 characters. */
export function randomSuffix(length = 4): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length];
  }
  return out;
}

/** `YYYYMMDD-HHmmss` in local time, so the folder name matches the clock the user is looking at. */
export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${ymd}-${hms}`;
}

/**
 * Default run name: `<project>-<YYYYMMDD>-<HHmmss>-<4 random chars>`, e.g.
 * `android-20260910-143201-k3x9`. Several projects are joined with `+`; with none, `run` is used.
 */
export function generateRunName(
  projects: readonly string[],
  now: Date = new Date(),
  suffix: string = randomSuffix(),
): string {
  const prefix = projects.length > 0 ? projects.join('+') : 'run';
  return sanitizeRunName(`${prefix}-${formatTimestamp(now)}-${suffix}`);
}

/**
 * The run name for the current process tree. Reads `APPWRIGHT_RUN_NAME` when set (by the appwright
 * CLI, by CI, or by an earlier call in this process), otherwise generates a default from the
 * `--project` arguments and stores it in the environment so worker processes inherit it.
 *
 * Idempotent: every call in a process, and in every child process, returns the same value.
 */
export function resolveRunName(argv: readonly string[] = process.argv): string {
  const fromEnv = process.env[RUN_NAME_ENV];
  let name: string;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    name = sanitizeRunName(fromEnv);
  } else {
    let projects: string[] = [];
    try {
      projects = parseProjectsFromArgv(argv);
    } catch {
      // A malformed --project is Playwright's error to report, not the run name's.
    }
    name = generateRunName(projects);
  }
  process.env[RUN_NAME_ENV] = name;
  return name;
}

/** Playwright `outputDir` for a run: `<base>/<runName>`. */
export function runOutputDir(runName: string, base: string = DEFAULT_OUTPUT_DIR): string {
  return path.join(base, runName);
}

/**
 * The run's Playwright `outputDir` for the current process.
 *
 * `defineConfig` resolves it (honouring a custom `outputDir` in the consumer config) and publishes
 * it through {@link OUTPUT_DIR_ENV}; Playwright re-evaluates the config in every worker, so the
 * value is available wherever appwright runs. Falls back to the default base for processes that
 * never loaded an appwright config.
 *
 * Note that Playwright's `--output <dir>` flag overrides `outputDir` after the config has been
 * evaluated, so it is not reflected here.
 */
export function resolveOutputDir(): string {
  const fromEnv = process.env[OUTPUT_DIR_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv;
  }
  return runOutputDir(resolveRunName());
}

/** Stores the run's resolved `outputDir` so every process of this run derives folders from it. */
export function publishOutputDir(outputDir: string): string {
  process.env[OUTPUT_DIR_ENV] = outputDir;
  return outputDir;
}

/** html reporter `outputFolder` for a run: `<base>/<runName>`. */
export function runReportDir(runName: string, base: string = DEFAULT_REPORT_DIR): string {
  return path.join(base, runName);
}

/** blob reporter `outputDir` for a run: `<base>/<runName>`. */
export function runBlobDir(runName: string, base: string = DEFAULT_BLOB_DIR): string {
  return path.join(base, runName);
}

/**
 * Playwright accepts `reporter: 'html'` as well as `reporter: [['html', {...}]]`. Returns the
 * array form, or `undefined` when no reporter was configured.
 */
export function normalizeReporters(
  reporter: PlaywrightTestConfig['reporter'],
): ReporterDescription[] | undefined {
  if (reporter === undefined) {
    return undefined;
  }
  if (typeof reporter === 'string') {
    return [[reporter]];
  }
  return reporter as ReporterDescription[];
}

/**
 * Nests the run name into the output folder of every reporter that owns a whole directory:
 * `html` (`outputFolder`) and `blob` (`outputDir`). Both wipe that directory when they write, so
 * without this two concurrent runs destroy each other's report.
 *
 * Reporters that write a single file to a path the consumer picked (`json`, `junit`) are left
 * alone: silently moving a path that CI reads would be worse than the collision it avoids.
 * The order of the list is preserved.
 */
export function applyRunNameToReporters(
  reporters: readonly ReporterDescription[],
  runName: string,
): ReporterDescription[] {
  return reporters.map((entry): ReporterDescription => {
    const [name, options] = Array.isArray(entry) ? entry : [entry, undefined];
    if (name === 'html') {
      const htmlOptions = (options ?? {}) as { outputFolder?: string };
      return [
        'html',
        {
          ...htmlOptions,
          outputFolder: runReportDir(runName, htmlOptions.outputFolder ?? DEFAULT_REPORT_DIR),
        },
      ];
    }
    if (name === 'blob') {
      const blobOptions = (options ?? {}) as { outputDir?: string };
      return [
        'blob',
        {
          ...blobOptions,
          outputDir: runBlobDir(runName, blobOptions.outputDir ?? DEFAULT_BLOB_DIR),
        },
      ];
    }
    return entry;
  });
}
