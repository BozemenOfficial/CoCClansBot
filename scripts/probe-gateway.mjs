import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createGateway } from '../gateway/server.ts';

// An invalid synthetic developer key tests the real network route, never account access.
const credential = randomBytes(32).toString('hex');
const upstreamStatuses = [];
const server = createGateway({
  apiToken: 'INVALID_CONNECTION_LAB_KEY', gatewayToken: credential,
  request: async (input, init) => {
    const response = await fetch(input, init);
    upstreamStatuses.push(response.status);
    return response;
  },
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No local gateway port');
const base = `http://127.0.0.1:${address.port}`;
const rows = [];
try {
  const unauthorized = await fetch(base + '/v1/players/%23P0Y');
  rows.push({ operation: 'unauthorized_client', status: unauthorized.status });
  const headers = { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' };
  const unknown = await fetch(base + '/v1/keys', { headers });
  rows.push({ operation: 'unknown_route', status: unknown.status });
  for (let round = 1; round <= 5; round++) {
    for (const operation of ['profile', 'verify_a', 'verify_b']) {
      const started = Date.now();
      const isPost = operation.startsWith('verify_');
      const response = await fetch(base + '/v1/players/%23P0Y' + (isPost ? '/verifytoken' : ''), {
        headers, method: isPost ? 'POST' : 'GET', signal: AbortSignal.timeout(7000),
        ...(isPost ? { body: JSON.stringify({ token: operation === 'verify_a' ? '00000000' : '11111111' }) } : {}),
      });
      await response.text();
      rows.push({ round, operation, status: response.status, elapsed_ms: Date.now() - started,
        upstream_status: upstreamStatuses.at(-1) ?? null, cache_control: response.headers.get('Cache-Control') });
    }
  }
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync('docs/evidence/gateway-probes.json', JSON.stringify({ observed_at: new Date().toISOString(),
    topology: 'execution environment -> loopback Node gateway -> official Supercell API',
    authenticated_with_supercell: false, synthetic_developer_key: true,
    note: 'This verifies gateway authentication, routing and real outbound HTTP. It does not establish a static IP, production HTTPS, successful player reads or verifytoken correctness.', rows }, null, 2) + '\n');
  console.log(JSON.stringify({ checks: rows.length, statuses: rows.map((row) => row.status), upstream_requests: upstreamStatuses.length }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
