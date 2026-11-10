import { timingSafeEqual } from 'node:crypto';
import { boundedFetch, RequestBudget, type Fetcher } from '../src/clients/http';
import { ServiceError } from '../src/errors';

interface LabEnv { LAB_SECRET: string }
const origins = { official: 'https://api.clashofclans.com', royaleapi: 'https://cocproxy.royaleapi.dev', clashking: 'https://api.clashk.ing/proxy' } as const;
const paths = { profile: '/v1/players/%23P0Y', clan: '/v1/clans/%232PP', verify_a: '/v1/players/%23P0Y/verifytoken', verify_b: '/v1/players/%23P0Y/verifytoken' } as const;

/** Temporary, authenticated connectivity probe. Never receives production credentials. */
export async function handleProbe(request: Request, env: LabEnv, upstream: Fetcher = fetch): Promise<Response> {
  const provided = request.headers.get('X-Lab-Secret') ?? '';
  const expected = env.LAB_SECRET ?? '';
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (b.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) return new Response('Forbidden', { status: 403 });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const query = new URL(request.url).searchParams;
  const target = query.get('target') ?? '';
  const operation = query.get('operation') ?? '';
  if (target !== 'egress' && !Object.hasOwn(origins, target)) return new Response('Unknown target', { status: 400 });
  if (target !== 'egress' && !Object.hasOwn(paths, operation)) return new Response('Unknown operation', { status: 400 });
  const method = operation.startsWith('verify_') ? 'POST' : 'GET';
  const url = target === 'egress' ? 'https://ipv4.icanhazip.com/'
    : origins[target as keyof typeof origins] + paths[operation as keyof typeof paths];
  const started = Date.now();
  const context = { target, operation: target === 'egress' ? 'public_ip' : operation, method, authenticated: false,
    colo: request.cf?.colo ?? null, checked_at: new Date().toISOString() };
  try {
    const response = await boundedFetch(new RequestBudget(1, 10_000), upstream)(url, {
      method, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      ...(method === 'POST' ? { body: JSON.stringify({ token: operation === 'verify_a' ? '00000000' : '11111111' }) } : {}),
    });
    const text = await response.text();
    const data: unknown = target === 'egress' ? { ip: text.trim() } : JSON.parse(text);
    const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
    return Response.json({ ...context, status: response.status, elapsed_ms: Date.now() - started,
      reason: typeof record.reason === 'string' ? record.reason.slice(0, 100) : typeof record.code === 'string' ? record.code.slice(0, 100) : null,
      message: typeof record.message === 'string' ? record.message.slice(0, 200) : null,
      ip: target === 'egress' && typeof record.ip === 'string' ? record.ip : null,
      cache_control: response.headers.get('Cache-Control'), cache_status: response.headers.get('CF-Cache-Status'),
      age: response.headers.get('Age'), rate_limit: response.headers.get('X-RateLimit-Limit'),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ...context, status: null, elapsed_ms: Date.now() - started,
      error: error instanceof ServiceError ? error.code : 'network_or_response_error' },
    { headers: { 'Cache-Control': 'no-store' } });
  }
}
export default {
  fetch(request: Request, env: LabEnv) { return handleProbe(request, env); },
} satisfies ExportedHandler<LabEnv>;
