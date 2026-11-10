import { describe, expect, it } from 'vitest';
import { memberTag, playerTagSchema } from '../src/validation/player';
import { actor, readUpdate, validSecret } from '../src/webhook';

it('normalizes game tags and rejects invalid characters', () => {
  expect(playerTagSchema.parse(' p0y ')).toBe('#P0Y');
  for (const tag of ['#ABC', '#', '#P0Y/path', '#P0Y\n#Q0Y']) expect(playerTagSchema.safeParse(tag).success).toBe(false);
});
it.each([
  ['👑 Archer 🇺🇦', 'Archer'], ['👨‍👩‍👧‍👦🔥', 'Игрок'], ['1️⃣Nick', 'Nick'],
  ['ABCDEFGHIJKLMNOPQRST', 'ABCDEFGHIJKLMNOP'], ['ab\u202ecd', 'abcd'],
  ['Воин 🏆', 'Воин'], [' cafe\u0301 ', 'café'],
])('cleans %s into a Telegram tag', (input, expected) => {
  expect(memberTag(input)).toBe(expected);
  expect(memberTag(input).length).toBeLessThanOrEqual(16);
});

describe('webhook boundary', () => {
  const request = (body: string) => new Request('https://example.com/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  it('checks the webhook secret', async () => {
    expect(await validSecret('s'.repeat(32), 's'.repeat(32))).toBe(true);
    expect(await validSecret('x'.repeat(32), 's'.repeat(32))).toBe(false);
    expect(await validSecret(null, 's'.repeat(32))).toBe(false);
  });
  it('rejects oversized or malformed bodies', async () => {
    expect(await readUpdate(request('not json'))).toBeNull();
    expect(await readUpdate(request(JSON.stringify({ update_id: 1, text: 'x'.repeat(1300000) })))).toBeNull();
    expect(await readUpdate(request('{"update_id":-1}'))).toBeNull();
    expect(await readUpdate(request('{"update_id":42}'))).toEqual({ update_id: 42 });
  });
  it('extracts the sender used for serialized conversations', () => {
    expect(actor({ callback_query: { from: { id: 12 } } })).toBe(12);
    expect(actor({ message: { from: { id: '12' } } })).toBeNull();
  });
});
