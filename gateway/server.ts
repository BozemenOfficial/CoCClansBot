import { createServer, type IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

interface GatewayOptions {
  apiToken: string;
  gatewayToken: string;
  request?: typeof fetch;
}

/** Run behind HTTPS on a machine whose outbound IP is allowed by Supercell. */
export function createGateway({ apiToken, gatewayToken, request = fetch }: GatewayOptions) {
  if (!apiToken || gatewayToken.length < 32) throw new Error('Set API key and a gateway credential of at least 32 characters.');
  const expected = createHash('sha256').update(`Bearer ${gatewayToken}`).digest();
  let active = 0;
  return createServer(async (req, res) => {
    const actual = createHash('sha256').update(req.headers.authorization ?? '').digest();
    if (!timingSafeEqual(actual, expected)) { res.writeHead(401).end(); return; }
    // This gateway can only call three fixed Supercell routes. It is not an open proxy.
    const path = req.url ?? '';
    const route = /^\/v1\/(players|clans)\/(%23|#)[0289PYLQGRJCUV]{3,14}(\/verifytoken)?$/.exec(path);
    const verify = route?.[1] === 'players' && route?.[3] === '/verifytoken';
    if (!route || (route[3] && !verify) || req.method !== (verify ? 'POST' : 'GET')) {
      res.writeHead(404).end(); return;
    }
    if (active >= 10) { res.writeHead(429, { 'Retry-After': '5' }).end(); return; }
    active++;
    try {
      const body = verify ? await verificationBody(req) : undefined;
      const response = await request(`https://api.clashofclans.com${path}`, {
        method: verify ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        ...(body ? { body } : {}),
      });
      // Error bodies can contain upstream diagnostics; clients need only the status.
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (response.status === 429) headers['Retry-After'] = response.headers.get('Retry-After') ?? '60';
      res.writeHead(response.status, headers);
      res.end(response.ok ? await response.text() : '{}');
    } catch { res.writeHead(502).end('{}'); }
    finally { active--; }
  });
}

async function verificationBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const data of req) {
    const chunk = Buffer.from(data);
    size += chunk.length;
    if (size > 512) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof body !== 'object' || body === null || !('token' in body) ||
      typeof body.token !== 'string' || !/^[a-z0-9]{6,128}$/i.test(body.token)) throw new Error('invalid_body');
  return JSON.stringify({ token: body.token });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { COC_API_TOKEN, COC_GATEWAY_TOKEN, PORT = '8788' } = process.env;
  const server = createGateway({ apiToken: COC_API_TOKEN ?? '', gatewayToken: COC_GATEWAY_TOKEN ?? '' });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.listen(Number(PORT), '127.0.0.1', () => console.log('Clash gateway listening on loopback. Put HTTPS in front of it.'));
}
