#!/usr/bin/env node
import { spawn } from 'child_process';

import { logger } from '../logger';
import { prepareInvocation } from './args';

function cmd(command: string[], options: { env?: Record<string, string> }): Promise<number> {
  let errorLogs: string[] = [];
  return new Promise((resolveFunc, rejectFunc) => {
    let p = spawn(command[0]!, command.slice(1), {
      env: { ...process.env, ...options.env },
    });
    p.stdout.on('data', (x) => {
      const log = x.toString();
      if (log.includes('Error')) {
        errorLogs.push(log);
      }
      process.stdout.write(log);
    });
    p.stderr.on('data', (x) => {
      const log = x.toString();
      process.stderr.write(x.toString());
      errorLogs.push(log);
    });
    p.on('exit', (code) => {
      if (code != 0) {
        // assuming last log is the error message before exiting
        rejectFunc(errorLogs.slice(-3).join('\n'));
      } else {
        resolveFunc(code!);
      }
    });
  });
}

(async function main() {
  let invocation: ReturnType<typeof prepareInvocation>;
  try {
    invocation = prepareInvocation(process.argv.slice(2));
  } catch (error: any) {
    logger.error(error?.message ?? String(error));
    process.exit(1);
  }
  logger.log(`Run name: ${invocation.runName}`);
  try {
    await cmd(['npx', 'playwright', ...invocation.pwArgs], { env: invocation.env });
  } catch (error: any) {
    logger.error(`Error while running playwright test: ${error}`);
    process.exit(1);
  }
})();
