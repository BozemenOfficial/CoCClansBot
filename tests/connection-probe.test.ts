import { expect, it, vi } from 'vitest';
import { handleProbe } from '../lab/probe-worker';
import type { Fetcher } from '../src/clients/http';

const env = { LAB_SECRET: 's'.repeat(64) };
function input(query: string, secret = env.LAB_SECRET) {
  return new Request('https://example.workers.dev/?' + query, { headers: { 'X-Lab-Secret': secret } });
}
it('does not make network requests without the lab secret', async () => {
  const request = vi.fn();
  expect((await handleProbe(input('target=official&operation=profile', 'bad'), env, request)).status).toBe(403);
  expect(request).not.toHaveBeenCalled();
});
it('does not allow arbitrary upstream hosts or routes', async () => {
  const request = vi.fn();
  expect((await handleProbe(input('target=https://untrusted.example&operation=profile'), env, request)).status).toBe(400);
  expect((await handleProbe(input('target=official&operation=../../secrets'), env, request)).status).toBe(400);
  expect((await handleProbe(input('target=__proto__&operation=profile'), env, request)).status).toBe(400);
  expect((await handleProbe(input('target=official&operation=toString'), env, request)).status).toBe(400);
  expect(request).not.toHaveBeenCalled();
});
it('forwards only a synthetic verification body and no credentials', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ reason: 'accessDenied', message: 'Missing authorization' }, { status: 403 }));
  const response = await handleProbe(input('target=royaleapi&operation=verify_a'), env, request as Fetcher);
  expect(request).toHaveBeenCalledWith('https://cocproxy.royaleapi.dev/v1/players/%23P0Y/verifytoken', expect.objectContaining({
    redirect: 'manual', method: 'POST', body: '{"token":"00000000"}',
  }));
  expect(JSON.stringify(request.mock.calls)).not.toContain(env.LAB_SECRET);
  expect(JSON.stringify(request.mock.calls)).not.toContain('Authorization');
  expect(await response.json()).toMatchObject({ status: 403, authenticated: false, reason: 'accessDenied' });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('does not return network exception details', async () => {
  const request = vi.fn<typeof fetch>(async () => { throw new Error('private request contents'); });
  const response = await handleProbe(input('target=official&operation=profile'), env, request as Fetcher);
  expect(await response.text()).not.toContain('private request contents');
});
