import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const spawned = vi.hoisted(() => [] as any[]);

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[]) => {
      const proc: any = new EventEmitter();
      proc.command = command;
      proc.args = args;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.exitCode = null;
      proc.signalCode = null;
      proc.kill = vi.fn(() => true);
      spawned.push(proc);
      return proc;
    }),
  };
});

import {
  AppiumPortInUseError,
  classifyAppiumOutput,
  resolveAppiumEntry,
  startAppiumServer,
} from '../providers/appium';

const READY = '[Appium] Appium REST http interface listener started on http://0.0.0.0:4723';

/** Exit listeners present before appium.ts registered its guard (on the first start). */
const exitListenersBefore = new Set(process.listeners('exit'));

const tempDirs: string[] = [];

beforeEach(() => {
  spawned.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function lastSpawned(): EventEmitter & {
  command: string;
  args: string[];
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  return spawned[spawned.length - 1];
}

/** A project dir whose node_modules/appium declares `bin`, as an installed Appium would. */
function fakeProject(bin: unknown): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appwright-appium-')));
  tempDirs.push(root);
  const pkgDir = path.join(root, 'node_modules', 'appium');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'appium', bin }));
  return root;
}

test('classifyAppiumOutput recognises the port clash and the ready line', () => {
  expect(classifyAppiumOutput('Error: listen EADDRINUSE: address already in use')).toBe(
    'port-in-use',
  );
  expect(classifyAppiumOutput('The requested port may already be in use.')).toBe('port-in-use');
  expect(classifyAppiumOutput(READY)).toBe('ready');
  expect(classifyAppiumOutput('[Appium] Welcome to Appium v3.2.0')).toBeUndefined();
});

test('resolveAppiumEntry prefers the Appium installed where the run starts, like npx', () => {
  const project = fakeProject({ appium: 'cli.js' });
  expect(resolveAppiumEntry([project, __dirname])).toBe(
    path.join(project, 'node_modules', 'appium', 'cli.js'),
  );
});

test('resolveAppiumEntry accepts a string bin and falls back to the next search path', () => {
  const project = fakeProject('bin/appium.js');
  expect(resolveAppiumEntry([project])).toBe(
    path.join(project, 'node_modules', 'appium', 'bin', 'appium.js'),
  );
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appwright-empty-')));
  tempDirs.push(empty);
  const own = resolveAppiumEntry([empty, __dirname]);
  expect(path.basename(own)).toBe('index.js');
  expect(fs.existsSync(own)).toBe(true);
});

test('spawns Appium with this Node binary, not through npx, so signals reach it', async () => {
  const started = startAppiumServer(4723);
  const proc = lastSpawned();
  expect(proc.command).toBe(process.execPath);
  expect(proc.args[0]).toBe(resolveAppiumEntry());
  expect(proc.args.slice(1, 3)).toEqual(['--port', '4723']);
  proc.stdout.emit('data', Buffer.from(READY));
  await expect(started).resolves.toBe(proc);
});

test('a port clash before the server is ready rejects and kills the process', async () => {
  const started = startAppiumServer(4723);
  const proc = lastSpawned();
  proc.stderr.emit('data', Buffer.from('Error: listen EADDRINUSE: address already in use'));
  await expect(started).rejects.toBeInstanceOf(AppiumPortInUseError);
  expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
});

test('output after the server is ready never kills the running server', async () => {
  const started = startAppiumServer(4723);
  const proc = lastSpawned();
  proc.stdout.emit('data', Buffer.from(READY));
  await started;
  proc.stderr.emit('data', Buffer.from('[Chromedriver] listen EADDRINUSE: address already in use'));
  proc.stdout.emit('data', Buffer.from('The requested port may already be in use'));
  expect(proc.kill).not.toHaveBeenCalled();
});

test('the exit guard kills a server that ignored SIGTERM', async () => {
  const started = startAppiumServer(4723);
  const proc = lastSpawned() as any;
  proc.stdout.emit('data', Buffer.from(READY));
  await started;
  const guards = process.listeners('exit').filter((listener) => !exitListenersBefore.has(listener));
  expect(guards).toHaveLength(1);
  // A delivered SIGTERM sets `killed` while the process may still be running.
  proc.killed = true;
  guards[0]!(0);
  expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  proc.emit('exit', null, 'SIGKILL');
  process.off('exit', guards[0]!);
});
