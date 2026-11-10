import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';

export const updateSchema = z.object({ update_id: z.number().int().nonnegative().safe() }).passthrough();

export async function validSecret(actual: string | null, expected: string): Promise<boolean> {
  if (!actual || expected.length < 32) return false;
  const encode = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', encode.encode(actual)), crypto.subtle.digest('SHA-256', encode.encode(expected))]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

export async function readUpdate(request: Request): Promise<z.infer<typeof updateSchema> | null> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return null;
  const max = 128 * 1024;
  if (Number(request.headers.get('content-length')) > max || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const result = updateSchema.safeParse(JSON.parse(new TextDecoder().decode(data)));
    return result.success ? result.data : null;
  } catch { return null; }
}

/** Only an ID is extracted here. grammY routes the supported update types. */
export function actor(update: Record<string, unknown>): number | null {
  for (const key of ['message', 'callback_query', 'my_chat_member', 'chat_member']) {
    const item = update[key];
    if (typeof item !== 'object' || item === null || !('from' in item)) continue;
    const from = item.from;
    if (typeof from === 'object' && from !== null && 'id' in from && typeof from.id === 'number' && Number.isSafeInteger(from.id)) return from.id;
  }
  return null;
}
