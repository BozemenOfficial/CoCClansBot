import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No real developer key or player token is accepted by this public connectivity check.
const labUrl = process.env.CONNECTION_LAB_URL;
const labSecret = process.env.CONNECTION_LAB_SECRET;
if (!labUrl || !labSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(labSecret)) {
  console.error('Set CONNECTION_LAB_URL and CONNECTION_LAB_SECRET for the temporary probe Worker.');
  process.exit(1);
}
const lab = new URL(labUrl);
if (lab.protocol !== 'https:' || lab.username || lab.password || !lab.hostname.endsWith('.workers.dev')) {
  console.error('The lab must be an HTTPS workers.dev URL.'); process.exit(1);
}
const folder = mkdtempSync(join(tmpdir(), 'coc-connections-'));
const secretFile = join(folder, 'request.curl');
writeFileSync(secretFile, `header = "X-Lab-Secret: ${labSecret}"\n`, { mode: 0o600 });
const cases = ['profile', 'clan', 'verify_a', 'verify_b'];
const rows = [];

function request(args) {
  const bodyPath = join(folder, 'body.json');
  const headersPath = join(folder, 'headers.txt');
  try {
    const text = execFileSync('curl', ['--silent', '--show-error', '--max-time', '20',
      '--output', bodyPath, '--dump-header', headersPath, '--write-out', '%{http_code}\n%{time_total}', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const [status, duration] = text.trim().split('\n');
    const body = readFileSync(bodyPath, 'utf8');
    const headers = readFileSync(headersPath, 'utf8');
    let data;
    try { data = JSON.parse(body); } catch { data = {}; }
    const header = (name) => [...headers.matchAll(new RegExp(`^${name}:\\s*(.*)$`, 'gmi'))].at(-1)?.[1]?.trim() ?? null;
    return { status: Number(status), wall_ms: Math.round(Number(duration) * 1000), data,
      cache_control: header('cache-control'), cache_status: header('cf-cache-status'), age: header('age') };
  } catch { return { status: null, wall_ms: null, data: {}, error: 'request_failed' }; }
}

try {
  for (let round = 1; round <= 5; round++) {
    for (const target of ['official', 'royaleapi', 'clashking']) {
      for (const operation of cases) {
        const path = operation === 'clan' ? '/v1/clans/%232PP' : '/v1/players/%23P0Y' + (operation.startsWith('verify_') ? '/verifytoken' : '');
        const origin = { official: 'https://api.clashofclans.com', royaleapi: 'https://cocproxy.royaleapi.dev', clashking: 'https://api.clashk.ing/proxy' }[target];
        const args = ['--url', origin + path];
        if (operation.startsWith('verify_')) args.push('--request', 'POST', '--header', 'Content-Type: application/json', '--data', JSON.stringify({ token: operation === 'verify_a' ? '00000000' : '11111111' }));
        const local = request(args);
        rows.push({ runtime: 'execution_environment', round, target, operation,
          status: local.status, elapsed_ms: local.wall_ms, authenticated: false,
          reason: local.data.reason ?? local.data.code ?? null, message: local.data.message ?? null,
          cache_control: local.cache_control ?? null, cache_status: local.cache_status ?? null,
          age: local.age ?? null, ...(local.error ? { error: local.error } : {}) });
        const probe = new URL(lab);
        probe.searchParams.set('target', target); probe.searchParams.set('operation', operation);
        probe.searchParams.set('sample', `${round}-${Date.now()}`);
        const cloud = request(['--config', secretFile, '--url', probe.href]);
        rows.push({ runtime: 'cloudflare_worker', round, target, operation, ...cloud.data,
          ...(cloud.status !== 200 ? { probe_http_status: cloud.status } : {}) });
      }
    }
    const probe = new URL(lab); probe.searchParams.set('target', 'egress'); probe.searchParams.set('sample', `${round}-${Date.now()}`);
    const egress = request(['--config', secretFile, '--url', probe.href]);
    rows.push({ runtime: 'cloudflare_worker', round, target: 'egress', operation: 'public_ip', ...egress.data,
      ...(egress.status !== 200 ? { probe_http_status: egress.status } : {}) });
    console.log(`Round ${round}/5 complete.`);
  }
  const result = { observed_at: new Date().toISOString(), rounds: 5, authenticated: false,
    note: 'HTTP authentication failures establish reachability only. They do not validate profile access, verifytoken correctness, token-dependent caching or a permanent source IP.', rows };
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync('docs/evidence/connection-probes.json', JSON.stringify(result, null, 2) + '\n');
  console.log('Saved sanitized observations to docs/evidence/connection-probes.json.');
} finally { rmSync(folder, { recursive: true, force: true }); }
