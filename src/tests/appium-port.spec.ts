import net from 'net';

import { afterEach, expect, test } from 'vitest';

import {
  AppiumPortInUseError,
  findFreePort,
  startAppiumServerOnFreePort,
} from '../providers/appium';

const blockers: net.Server[] = [];

function hold(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      blockers.push(server);
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(
    blockers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

test('returns the preferred port when it is free', async () => {
  const preferred = 47231;
  expect(await findFreePort(preferred)).toBe(preferred);
});

test('falls back when the port is held on the wildcard address, as Appium binds it', async () => {
  const preferred = 47232;
  await hold(preferred, '0.0.0.0');
  const port = await findFreePort(preferred);
  expect(port).not.toBe(preferred);
  expect(port).toBeGreaterThan(0);
});

test('startAppiumServerOnFreePort retries once on a new port when the port is taken', async () => {
  const attempts: number[] = [];
  const picked = [4723, 50123];
  const handle = await startAppiumServerOnFreePort(4723, {
    pickPort: async () => picked.shift()!,
    start: async (port) => {
      attempts.push(port);
      if (attempts.length === 1) {
        throw new AppiumPortInUseError(port);
      }
      return { pid: 1 } as any;
    },
  });
  expect(attempts).toEqual([4723, 50123]);
  expect(handle.port).toBe(50123);
});

test('startAppiumServerOnFreePort gives up after the retry budget', async () => {
  let calls = 0;
  await expect(
    startAppiumServerOnFreePort(4723, {
      pickPort: async () => 4723 + calls,
      start: async (port) => {
        calls++;
        throw new AppiumPortInUseError(port);
      },
    }),
  ).rejects.toBeInstanceOf(AppiumPortInUseError);
  expect(calls).toBe(2);
});

test('startAppiumServerOnFreePort does not retry other start failures', async () => {
  let calls = 0;
  await expect(
    startAppiumServerOnFreePort(4723, {
      pickPort: async () => 4723,
      start: async () => {
        calls++;
        throw new Error('spawn failed');
      },
    }),
  ).rejects.toThrow('spawn failed');
  expect(calls).toBe(1);
});
