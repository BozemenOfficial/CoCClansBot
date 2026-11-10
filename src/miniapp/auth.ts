import { z } from 'zod';

const encoder = new TextEncoder();
const userSchema = z.object({
  id: z.number().int().positive().safe(), first_name: z.string().max(256),
  username: z.string().max(64).optional(), is_bot: z.literal(false).optional(),
});
export type AppUser = z.infer<typeof userSchema>;

/** Identity comes only from Telegram's signed initData, never initDataUnsafe or request JSON. */
export async function authenticate(initData: string, botToken: string, now = Math.floor(Date.now() / 1000)): Promise<AppUser | null> {
  if (!initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) return null;
    seen.add(key);
  }
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  const date = params.get('auth_date');
  if (!date || !/^\d+$/.test(date)) return null;
  const issued = Number(date);
  if (!Number.isSafeInteger(issued) || issued > now + 30 || now - issued > 3600) return null;
  params.delete('hash');
  const check = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', key, encoder.encode(botToken));
  const verifyKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(hash.match(/.{2}/g)!, (hex) => parseInt(hex, 16));
  if (!await crypto.subtle.verify('HMAC', verifyKey, signature, encoder.encode(check))) return null;
  try {
    const user = userSchema.safeParse(JSON.parse(params.get('user') ?? 'null'));
    return user.success ? user.data : null;
  } catch { return null; }
}
