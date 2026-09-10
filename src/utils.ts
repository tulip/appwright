import fs from 'fs';
import path from 'path';

import test from '@playwright/test';

import { resolveRunName, runOutputDir, VIDEOS_STORE_DIR } from './run-name';

export function boxedStep(target: Function, context: ClassMethodDecoratorContext) {
  return function replacementMethod(
    this: {
      selector: string | RegExp;
    },
    ...args: any
  ) {
    const path = this.selector ? `("${this.selector}")` : '';
    const argsString = args.length
      ? '(' +
        Array.from(args)
          .map((a) => JSON.stringify(a))
          .join(' , ') +
        ')'
      : '';
    const name = `${context.name as string}${path}${argsString}`;
    return test.step(
      name,
      async () => {
        return await target.call(this, ...args);
      },
      { box: true },
    );
  };
}

export function validateBuildPath(buildPath: string | undefined, expectedExtension: string) {
  if (!buildPath) {
    throw new Error(`Build path not found. Please set the build path in appwright.config.ts`);
  }

  if (!buildPath.endsWith(expectedExtension)) {
    throw new Error(
      `File path is not supported for the given combination of platform and provider. Please provide build with ${expectedExtension} file extension in the appwright.config.ts`,
    );
  }

  if (!fs.existsSync(buildPath)) {
    throw new Error(
      `File not found at given path: ${buildPath}
Please provide the correct path of the build.`,
    );
  }
}

export function getLatestBuildToolsVersions(versions: string[]): string | undefined {
  return versions.sort((a, b) => (a > b ? -1 : 1))[0];
}

export function longestDeterministicGroup(pattern: RegExp): string | undefined {
  const patternToString = pattern.toString();
  const matches = [...patternToString.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]);
  if (!matches || !matches.length) {
    return undefined;
  }
  const noSpecialChars: string[] = matches.filter((match): match is string => {
    if (!match) {
      return false;
    }
    const regexSpecialCharsPattern = /[.*+?^${}()|[\]\\]/;
    return !regexSpecialCharsPattern.test(match);
  });
  const longestString = noSpecialChars.reduce(
    (max, str) => (str.length > max.length ? str : max),
    '',
  );
  if (longestString == '') {
    return undefined;
  }
  return longestString;
}

/**
 * Folder for this run's worker videos and worker-info files: `test-results/<run>/videos-store`.
 * It lives inside Playwright's per-run output dir (which Playwright clears at the start of a run)
 * rather than inside the html report folder, which the html reporter deletes before it copies
 * attachments.
 */
export function basePath() {
  return path.join(process.cwd(), runOutputDir(resolveRunName()), VIDEOS_STORE_DIR);
}

export function isNoSuchWindowError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name && error.name.toLowerCase().includes('nosuchwindowerror')) {
      return true;
    }
    if (error.message && error.message.toLowerCase().includes('no such window')) {
      return true;
    }
  }
  const errorString = String(error).toLowerCase();
  return errorString.includes('no such window') || errorString.includes('nosuchwindowerror');
}
