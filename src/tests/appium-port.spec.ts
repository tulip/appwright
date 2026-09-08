import net from 'net';

import { afterEach, expect, test } from 'vitest';

import { findFreePort } from '../providers/appium';

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
