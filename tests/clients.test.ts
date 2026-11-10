import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config';
import { ClashClient } from '../src/clients/clash';
import { RequestBudget, boundedFetch, type Fetcher } from '../src/clients/http';
import { player } from './fixtures';

const config = () => readConfig({ DB: {} as D1Database, BOT_TOKEN: '999:test', WEBHOOK_SECRET: 's'.repeat(32), COC_API_TOKEN: 'developer-key' });
const fakeFetch = (fn: ReturnType<typeof vi.fn>) => fn as unknown as Fetcher;

describe('Clash transport', () => {
  it('encodes tags and sends a separate gateway credential', async () => {
    const cfg = { ...config(), COC_TRANSPORT: 'gateway' as const, COC_API_BASE_URL: 'https://gateway.example/v1', COC_GATEWAY_TOKEN: 'gateway-secret' };
    const request = vi.fn(async () => Response.json(player));
    await new ClashClient(cfg, fakeFetch(request)).player('#P0Y');
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/players/%23P0Y');
    expect(options.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer gateway-secret' }));
    expect(JSON.stringify(options)).not.toContain('developer-key');
    expect(options.redirect).toBe('manual');
  });
  it.each([[403, 'access_denied'], [404, 'not_found'], [429, 'rate_limited'], [503, 'upstream_unavailable']])('handles HTTP %s safely', async (status, code) => {
    const request = vi.fn(async () => new Response('private upstream error', { status: Number(status) }));
    await expect(new ClashClient(config(), fakeFetch(request)).player('#P0Y')).rejects.toMatchObject({ code });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects an unexpected player response', async () => {
    const request = vi.fn(async () => Response.json({ ...player, tag: '#Q0Y' }));
    await expect(new ClashClient(config(), fakeFetch(request)).player('#P0Y')).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('never exposes a failed request token in the thrown error', async () => {
    const request = vi.fn(async () => { throw new Error('TOKEN_ABC'); });
    await expect(new ClashClient(config(), fakeFetch(request)).verify('#P0Y', 'PLAYER_TOKEN')).rejects.toThrow('upstream_unavailable');
  });
  it('bounds requests and disables redirects', async () => {
    const request = vi.fn(async () => new Response('OK'));
    const limited = boundedFetch(new RequestBudget(1), fakeFetch(request));
    await limited('https://example.com');
    await expect(limited('https://example.com')).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(request).toHaveBeenCalledTimes(1);
    expect((request.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ redirect: 'manual' });
  });
  it('does not allow a custom URL to receive the official developer key', () => {
    expect(() => readConfig({ DB: {} as D1Database, BOT_TOKEN: '999:test', WEBHOOK_SECRET: 's'.repeat(32), COC_API_TOKEN: 'key', COC_API_BASE_URL: 'https://unknown.example/v1' })).toThrow('invalid_configuration');
  });
});

it('allows the Telegram service to run before Clash API is configured, without sending upstream requests', async () => {
  const cfg = readConfig({ DB: {} as D1Database, BOT_TOKEN: '999:test', WEBHOOK_SECRET: 's'.repeat(32), COC_TRANSPORT: 'disabled' });
  const request = vi.fn();
  const client = new ClashClient(cfg, fakeFetch(request));
  expect(client.available).toBe(false);
  await expect(client.player('#P0Y')).rejects.toMatchObject({ code: 'integration_not_configured' });
  await expect(client.verify('#P0Y', 'ABC12345')).rejects.toMatchObject({ code: 'integration_not_configured' });
  expect(request).not.toHaveBeenCalled();
});

it('blocks redirects explicitly using a redirect mode supported by Workers', async () => {
  const request = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/' } }));
  const limited = boundedFetch(new RequestBudget(), fakeFetch(request));
  await expect(limited('https://api.telegram.org/test', { headers: { Authorization: 'Bearer private' } }))
    .rejects.toMatchObject({ code: 'redirect_blocked' });
  expect(request).toHaveBeenCalledTimes(1);
  expect((request.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
});
