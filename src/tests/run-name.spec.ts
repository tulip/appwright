import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  applyRunNameToReporters,
  extractRunNameArg,
  formatTimestamp,
  generateRunName,
  normalizeReporters,
  parseProjectsFromArgv,
  randomSuffix,
  resolveRunName,
  RUN_NAME_ENV,
  runOutputDir,
  runReportDir,
  sanitizeRunName,
} from '../run-name';

describe('sanitizeRunName', () => {
  test('keeps letters, digits, dots, underscores, dashes and plus signs', () => {
    expect(sanitizeRunName('android-20260910-143201-k3x9')).toBe('android-20260910-143201-k3x9');
    expect(sanitizeRunName('ios+android_v1.2')).toBe('ios+android_v1.2');
  });

  test('replaces runs of other characters with a single dash', () => {
    expect(sanitizeRunName('nightly run #3 (ios)')).toBe('nightly-run-3-ios-');
    expect(sanitizeRunName('a/b\\c:d')).toBe('a-b-c-d');
  });

  test('strips surrounding whitespace and leading dots', () => {
    expect(sanitizeRunName('  smoke  ')).toBe('smoke');
    expect(sanitizeRunName('..hidden')).toBe('hidden');
    expect(sanitizeRunName('../escape')).toBe('-escape');
  });

  test('throws when nothing usable is left', () => {
    expect(() => sanitizeRunName('')).toThrow(/no usable characters/);
    expect(() => sanitizeRunName('   ')).toThrow(/no usable characters/);
    expect(() => sanitizeRunName('...')).toThrow(/no usable characters/);
  });
});

describe('formatTimestamp', () => {
  test('formats local time as YYYYMMDD-HHmmss with zero padding', () => {
    expect(formatTimestamp(new Date(2026, 8, 10, 14, 32, 1))).toBe('20260910-143201');
    expect(formatTimestamp(new Date(2026, 0, 5, 3, 4, 9))).toBe('20260105-030409');
  });
});

describe('randomSuffix', () => {
  test('returns lowercase base36 characters of the requested length', () => {
    expect(randomSuffix()).toMatch(/^[0-9a-z]{4}$/);
    expect(randomSuffix(8)).toMatch(/^[0-9a-z]{8}$/);
  });
});

describe('generateRunName', () => {
  const now = new Date(2026, 8, 10, 14, 32, 1);

  test('is <project>-<YYYYMMDD>-<HHmmss>-<suffix>', () => {
    expect(generateRunName(['android'], now, 'k3x9')).toBe('android-20260910-143201-k3x9');
  });

  test('joins several projects with a plus sign', () => {
    expect(generateRunName(['ios', 'android'], now, 'k3x9')).toBe('ios+android-20260910-143201-k3x9');
  });

  test('falls back to "run" when no project is selected', () => {
    expect(generateRunName([], now, 'k3x9')).toBe('run-20260910-143201-k3x9');
  });

  test('sanitizes project names', () => {
    expect(generateRunName(['my project'], now, 'k3x9')).toBe('my-project-20260910-143201-k3x9');
  });

  test('uses the current time and a random suffix by default', () => {
    expect(generateRunName(['ios'])).toMatch(/^ios-\d{8}-\d{6}-[0-9a-z]{4}$/);
  });
});

describe('parseProjectsFromArgv', () => {
  test('reads --project values in both flag forms', () => {
    expect(parseProjectsFromArgv(['test', '--project', 'android'])).toEqual(['android']);
    expect(parseProjectsFromArgv(['test', '--project=ios'])).toEqual(['ios']);
    expect(parseProjectsFromArgv(['--project', 'a', '--project=b'])).toEqual(['a', 'b']);
  });

  test('returns an empty list when the flag is absent', () => {
    expect(parseProjectsFromArgv(['test', '--grep', 'login'])).toEqual([]);
  });

  test('throws when the flag has no value', () => {
    expect(() => parseProjectsFromArgv(['test', '--project'])).toThrow(/Project name is required/);
    expect(() => parseProjectsFromArgv(['test', '--project', '--headed'])).toThrow(
      /Project name is required/,
    );
    expect(() => parseProjectsFromArgv(['test', '--project='])).toThrow(/Project name is required/);
  });
});

describe('extractRunNameArg', () => {
  test('returns the name and argv without the flag', () => {
    expect(extractRunNameArg(['test', '--run-name', 'smoke', '--project', 'ios'])).toEqual({
      runName: 'smoke',
      rest: ['test', '--project', 'ios'],
    });
    expect(extractRunNameArg(['test', '--run-name=smoke'])).toEqual({
      runName: 'smoke',
      rest: ['test'],
    });
  });

  test('the last occurrence wins', () => {
    expect(extractRunNameArg(['--run-name', 'a', '--run-name', 'b'])).toEqual({
      runName: 'b',
      rest: [],
    });
  });

  test('leaves argv alone when the flag is absent', () => {
    expect(extractRunNameArg(['test', '--project', 'ios'])).toEqual({
      rest: ['test', '--project', 'ios'],
    });
  });

  test('throws when the value is missing', () => {
    expect(() => extractRunNameArg(['test', '--run-name'])).toThrow(/--run-name requires a value/);
    expect(() => extractRunNameArg(['test', '--run-name', '--project', 'ios'])).toThrow(
      /--run-name requires a value/,
    );
    expect(() => extractRunNameArg(['test', '--run-name='])).toThrow(/--run-name requires a value/);
  });
});

describe('resolveRunName', () => {
  const original = process.env[RUN_NAME_ENV];

  beforeEach(() => {
    delete process.env[RUN_NAME_ENV];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[RUN_NAME_ENV];
    } else {
      process.env[RUN_NAME_ENV] = original;
    }
  });

  test('uses the environment value when set, sanitized', () => {
    process.env[RUN_NAME_ENV] = 'nightly run';
    expect(resolveRunName(['--project', 'ios'])).toBe('nightly-run');
    expect(process.env[RUN_NAME_ENV]).toBe('nightly-run');
  });

  test('generates a default from --project and stores it in the environment', () => {
    const name = resolveRunName(['node', 'playwright', 'test', '--project', 'android']);
    expect(name).toMatch(/^android-\d{8}-\d{6}-[0-9a-z]{4}$/);
    expect(process.env[RUN_NAME_ENV]).toBe(name);
  });

  test('is idempotent within a process', () => {
    const first = resolveRunName(['--project', 'ios']);
    const second = resolveRunName(['--project', 'android']);
    expect(second).toBe(first);
  });

  test('treats a blank environment value as unset', () => {
    process.env[RUN_NAME_ENV] = '   ';
    expect(resolveRunName([])).toMatch(/^run-\d{8}-\d{6}-[0-9a-z]{4}$/);
  });

  test('ignores a malformed --project and still produces a name', () => {
    expect(resolveRunName(['test', '--project'])).toMatch(/^run-\d{8}-\d{6}-[0-9a-z]{4}$/);
  });
});

describe('runOutputDir / runReportDir', () => {
  test('nest the run name under the default folders', () => {
    expect(runOutputDir('smoke')).toBe(path.join('test-results', 'smoke'));
    expect(runReportDir('smoke')).toBe(path.join('playwright-report', 'smoke'));
  });

  test('nest the run name under a custom base', () => {
    expect(runOutputDir('smoke', 'out')).toBe(path.join('out', 'smoke'));
    expect(runReportDir('smoke', '/abs/report')).toBe(path.join('/abs/report', 'smoke'));
  });
});

describe('normalizeReporters', () => {
  test('wraps a bare reporter name', () => {
    expect(normalizeReporters('html')).toEqual([['html']]);
  });

  test('passes arrays through and leaves undefined alone', () => {
    expect(normalizeReporters([['list'], ['html', { open: 'never' }]])).toEqual([
      ['list'],
      ['html', { open: 'never' }],
    ]);
    expect(normalizeReporters(undefined)).toBeUndefined();
  });
});

describe('applyRunNameToReporters', () => {
  test('adds outputFolder to an html entry without options', () => {
    expect(applyRunNameToReporters([['html']], 'smoke')).toEqual([
      ['html', { outputFolder: path.join('playwright-report', 'smoke') }],
    ]);
  });

  test('keeps existing html options and nests a custom outputFolder', () => {
    expect(
      applyRunNameToReporters([['html', { open: 'never', outputFolder: 'reports' }]], 'smoke'),
    ).toEqual([['html', { open: 'never', outputFolder: path.join('reports', 'smoke') }]]);
  });

  test('leaves other reporters and their order untouched', () => {
    const custom = '/abs/path/to/reporter.js';
    expect(
      applyRunNameToReporters([[custom], ['list'], ['html', { open: 'always' }], ['json']], 'smoke'),
    ).toEqual([
      [custom],
      ['list'],
      ['html', { open: 'always', outputFolder: path.join('playwright-report', 'smoke') }],
      ['json'],
    ]);
  });
});
