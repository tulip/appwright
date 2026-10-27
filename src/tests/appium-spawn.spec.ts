import { EventEmitter } from 'events';
import path from 'path';

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { afterEach, expect, test, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn,
}));

import { startAppiumServer } from '../providers/appium';

/** A child process that prints Appium's ready line as soon as it is spawned. */
function readyProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    killed: false,
    kill: vi.fn(),
  });
  setImmediate(() =>
    proc.stdout.emit('data', Buffer.from('Appium REST http interface listener started')),
  );
  return proc;
}

afterEach(() => {
  vi.restoreAllMocks();
  spawn.mockReset();
});

test('spawns Appium with the bundled ffmpeg folder at the end of PATH', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  spawn.mockImplementation(() => readyProcess());

  await startAppiumServer(47299);

  const env = spawn.mock.calls[0]![2].env as NodeJS.ProcessEnv;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')!;
  const entries = env[pathKey]!.split(path.delimiter);
  expect(entries.at(-1)).toBe(path.dirname(ffmpegInstaller.path));
  expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toHaveLength(1);
});
