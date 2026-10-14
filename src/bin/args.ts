import { DEVICE_ENV, WAIT_FOR_DEVICE_ENV } from '../providers/device-pool';
import {
  extractRunNameArg,
  generateRunName,
  parseProjectsFromArgv,
  RUN_NAME_ENV,
  sanitizeRunName,
  takeFlag,
} from '../run-name';

export const DEFAULT_CONFIG_FILE = 'appwright.config.ts';
export const DEVICE_FLAG = '--device';
export const WAIT_FOR_DEVICE_FLAG = '--wait-for-device';

export type Invocation = {
  /** Arguments to hand to the Playwright CLI, with appwright-only flags removed. */
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
 * Splits `--device <udid|name>` and `--wait-for-device <seconds>` out of the CLI arguments
 * (Playwright would reject them). The last occurrence of each wins.
 */
export function extractDeviceArgs(argv: readonly string[]): {
  device?: string;
  waitForDevice?: string;
  rest: string[];
} {
  const device = takeFlag(
    argv,
    DEVICE_FLAG,
    `${DEVICE_FLAG} requires a udid or name, e.g. \`${DEVICE_FLAG} emulator-5554\``,
  );
  const wait = takeFlag(
    device.rest,
    WAIT_FOR_DEVICE_FLAG,
    `${WAIT_FOR_DEVICE_FLAG} requires a number of seconds, e.g. \`${WAIT_FOR_DEVICE_FLAG} 300\``,
  );
  const deviceValue = device.values[device.values.length - 1]?.trim();
  if (deviceValue === '') {
    throw new Error(`${DEVICE_FLAG} requires a udid or name.`);
  }
  const waitValue = wait.values[wait.values.length - 1];
  if (waitValue !== undefined) {
    const seconds = Number(waitValue);
    if (waitValue.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
      throw new Error(
        `${WAIT_FOR_DEVICE_FLAG} must be a non-negative number of seconds, got "${waitValue}".`,
      );
    }
  }
  return {
    ...(deviceValue !== undefined && { device: deviceValue }),
    ...(waitValue !== undefined && { waitForDevice: waitValue.trim() }),
    rest: wait.rest,
  };
}

/**
 * Turns the appwright CLI arguments into a Playwright invocation.
 *
 * - `--run-name <name>` is removed (Playwright would reject it) and passed on as `APPWRIGHT_RUN_NAME`.
 * - Run name precedence: flag, then `APPWRIGHT_RUN_NAME` already in the environment, then a
 *   generated `<project>-<timestamp>-<suffix>` default.
 * - `--device <udid|name>` and `--wait-for-device <seconds>` are removed and passed on as
 *   `APPWRIGHT_DEVICE` / `APPWRIGHT_WAIT_FOR_DEVICE`; when absent, those variables already in the
 *   environment apply unchanged.
 * - `--config appwright.config.ts` is appended when no config flag is given.
 */
export function prepareInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Invocation {
  const { runName: fromFlag, rest: withoutRunName } = extractRunNameArg(argv);
  const { device, waitForDevice, rest } = extractDeviceArgs(withoutRunName);
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

  return {
    pwArgs,
    env: {
      [RUN_NAME_ENV]: runName,
      ...(device !== undefined && { [DEVICE_ENV]: device }),
      ...(waitForDevice !== undefined && { [WAIT_FOR_DEVICE_ENV]: waitForDevice }),
    },
    runName,
  };
}
