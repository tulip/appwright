import {
  extractRunNameArg,
  generateRunName,
  parseProjectsFromArgv,
  RUN_NAME_ENV,
  sanitizeRunName,
} from '../run-name';

export const DEFAULT_CONFIG_FILE = 'appwright.config.ts';

export type Invocation = {
  /** Arguments to hand to `npx playwright`, with appwright-only flags removed. */
  pwArgs: string[];
  /** Extra environment for the Playwright process. */
  env: Record<string, string>;
  runName: string;
};

function hasConfigFlag(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg === '--config' || arg === '-c' || arg.startsWith('--config=') || arg.startsWith('-c='),
  );
}

/**
 * Turns the appwright CLI arguments into a Playwright invocation.
 *
 * - `--run-name <name>` is removed (Playwright would reject it) and passed on as `APPWRIGHT_RUN_NAME`.
 * - Run name precedence: flag, then `APPWRIGHT_RUN_NAME` already in the environment, then a
 *   generated `<project>-<timestamp>-<suffix>` default.
 * - `--config appwright.config.ts` is appended when no config flag is given.
 */
export function prepareInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Invocation {
  const { runName: fromFlag, rest } = extractRunNameArg(argv);
  const pwArgs = [...rest];
  if (!hasConfigFlag(pwArgs)) {
    pwArgs.push('--config', DEFAULT_CONFIG_FILE);
  }

  const fromEnv = env[RUN_NAME_ENV];
  let runName: string;
  if (fromFlag !== undefined) {
    runName = sanitizeRunName(fromFlag);
  } else if (fromEnv !== undefined && fromEnv.trim() !== '') {
    runName = sanitizeRunName(fromEnv);
  } else {
    runName = generateRunName(parseProjectsFromArgv(pwArgs));
  }

  return { pwArgs, env: { [RUN_NAME_ENV]: runName }, runName };
}
