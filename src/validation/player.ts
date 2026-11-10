import { z } from 'zod';

export const playerTagSchema = z.string().trim().toUpperCase()
  .transform((tag) => tag.startsWith('#') ? tag : `#${tag}`)
  .pipe(z.string().regex(/^#[0289PYLQGRJCUV]{3,14}$/));

export function memberTag(name: string): string {
  // Keep whole graphemes. Remove pictographs, flags, keycaps, controls and joiners.
  const segments = new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(name.normalize('NFKC'));
  let result = '';
  for (const { segment } of segments) {
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|\u200d|\ufe0e|\ufe0f/u.test(segment)) continue;
    const clean = segment.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '');
    // UTF-16 length is conservative for Telegram's character limit.
    if (result.length + clean.length > 16) break;
    result += clean;
  }
  return result.replace(/\s+/gu, ' ').trim() || 'Игрок';
}
