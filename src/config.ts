import { z } from 'zod';

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  COC_API_TOKEN?: string;
  COC_GATEWAY_TOKEN?: string;
  COC_API_BASE_URL?: string;
  COC_TRANSPORT?: string;
  SYNC_BATCH_SIZE?: string;
}

const schema = z.object({
  BOT_TOKEN: z.string().regex(/^\d+:[\w-]+$/),
  WEBHOOK_SECRET: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
  COC_TRANSPORT: z.enum(['direct', 'gateway', 'disabled']).default('direct'),
  COC_API_BASE_URL: z.url().default('https://api.clashofclans.com/v1'),
  COC_API_TOKEN: z.string().min(1).optional(),
  COC_GATEWAY_TOKEN: z.string().min(1).optional(),
  SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(8),
}).superRefine((v, ctx) => {
  const url = new URL(v.COC_API_BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    ctx.addIssue({ code: 'custom', message: 'Invalid API URL' });
  }
  if (v.COC_TRANSPORT === 'direct' &&
      (url.origin !== 'https://api.clashofclans.com' || url.pathname.replace(/\/$/, '') !== '/v1' || !v.COC_API_TOKEN)) {
    ctx.addIssue({ code: 'custom', message: 'Direct transport requires official URL and API key' });
  }
  if (v.COC_TRANSPORT === 'gateway' && !v.COC_GATEWAY_TOKEN) {
    ctx.addIssue({ code: 'custom', message: 'Gateway credential required' });
  }
});

export type Config = z.infer<typeof schema>;
export function readConfig(env: Env): Config {
  const result = schema.safeParse(env);
  // Zod errors may contain input. Never log them or return them over HTTP.
  if (!result.success) throw new Error('invalid_configuration');
  return result.data;
}
