import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createGateway } from '../gateway/server';

let server: ReturnType<typeof createGateway> | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); server.close(); await once(server, 'close'); server = undefined; } });

it('authenticates the gateway and only forwards allowed routes with the upstream key', async () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ status: 'ok' }));
  server = createGateway({ apiToken: 'supercell-key', gatewayToken: 'g'.repeat(32), request: upstream });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { authorization: `Bearer ${'g'.repeat(32)}`, 'content-type': 'application/json' };
  expect((await fetch(`${base}/v1/players/%23P0Y`)).status).toBe(401);
  expect((await fetch(`${base}/v1/keys`, { headers })).status).toBe(404);
  expect((await fetch(`${base}/v1/clans/%23P0Y/verifytoken`, { headers, method: 'POST' })).status).toBe(404);
  expect((await fetch(`${base}/v1/players/%23P0Y/verifytoken`, { headers, method: 'POST', body: JSON.stringify({ token: 'ABC12345', extra: 'discard' }) })).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream).toHaveBeenCalledWith('https://api.clashofclans.com/v1/players/%23P0Y/verifytoken', expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer supercell-key' }), body: '{"token":"ABC12345"}', redirect: 'error',
  }));
});
