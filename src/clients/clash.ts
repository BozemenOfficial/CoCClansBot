import { z } from 'zod';
import type { Config } from '../config';
import { ServiceError } from '../errors';
import type { Fetcher } from './http';

const clanSchema = z.object({ tag: z.string(), name: z.string().max(100) });
const playerSchema = z.object({
  tag: z.string(), name: z.string().max(100),
  townHallLevel: z.number().int(), expLevel: z.number().int(), trophies: z.number().int(),
  donations: z.number().int().default(0), donationsReceived: z.number().int().default(0),
  role: z.string().optional(), clan: clanSchema.optional(),
});
export type Player = z.infer<typeof playerSchema>;
export type Clan = z.infer<typeof clanSchema>;
export interface ClashApi {
  readonly available?: boolean;
  player(tag: string): Promise<Player>;
  clan(tag: string): Promise<Clan>;
  verify(tag: string, token: string): Promise<boolean>;
}

export class ClashClient implements ClashApi {
  private readonly players = new Map<string, Player>();
  get available(): boolean { return this.config.COC_TRANSPORT !== 'disabled'; }
  constructor(private readonly config: Config, private readonly request: Fetcher = fetch) {}

  private async call(path: string, body?: object): Promise<unknown> {
    if (!this.available) throw new ServiceError('integration_not_configured');
    const token = this.config.COC_TRANSPORT === 'gateway'
      ? this.config.COC_GATEWAY_TOKEN : this.config.COC_API_TOKEN;
    let response: Response;
    try {
      response = await this.request(`${this.config.COC_API_BASE_URL.replace(/\/$/, '')}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      throw new ServiceError('upstream_unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new ServiceError('not_found');
      if (response.status === 401 || response.status === 403) throw new ServiceError('access_denied');
      if (response.status === 429) {
        const delay = Number(response.headers.get('Retry-After'));
        throw new ServiceError('rate_limited', Number.isFinite(delay) ? Math.min(3600, Math.max(60, delay)) : 60);
      }
      throw new ServiceError('upstream_unavailable');
    }
    try { return await response.json(); } catch { throw new ServiceError('invalid_response'); }
  }
  async player(tag: string): Promise<Player> {
    const cached = this.players.get(tag);
    if (cached) return cached;
    const result = playerSchema.safeParse(await this.call(`/players/${encodeURIComponent(tag)}`));
    if (!result.success || result.data.tag !== tag) throw new ServiceError('invalid_response');
    this.players.set(tag, result.data);
    return result.data;
  }
  async clan(tag: string): Promise<Clan> {
    const result = clanSchema.safeParse(await this.call(`/clans/${encodeURIComponent(tag)}`));
    if (!result.success || result.data.tag !== tag) throw new ServiceError('invalid_response');
    return result.data;
  }
  async verify(tag: string, token: string): Promise<boolean> {
    const result = z.object({ status: z.enum(['ok', 'invalid']) })
      .safeParse(await this.call(`/players/${encodeURIComponent(tag)}/verifytoken`, { token }));
    if (!result.success) throw new ServiceError('invalid_response');
    return result.data.status === 'ok';
  }
}
