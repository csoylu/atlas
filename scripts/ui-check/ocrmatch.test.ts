import { describe, expect, it } from 'vitest';
import { boxOf, labelRead } from './ocrmatch.mjs';

// The 1100 px « chat-system » row of #343, in css px: the label is the ellipsized prompt (79% of it shown).
const key = { text: 'Trigger a push notification to Master: call card_block with kind “needs_input”. A_very_long', shown: 0.79, x: 330, y: 700, w: 400, h: 20 };
const scale = 2;
const at = (text: string, x: number, conf = 1) => ({ text, conf, x: x * scale, y: key.y * scale + 2, w: 40, h: 28 });

describe('labelRead (#343)', () => {
  it('a box holding only the row chevron is not a read label: Vision dropped the text', () => {
    const r = labelRead(key, [at('>', 700)], scale);
    expect(r.ok).toBe(false);
    expect(r.read).toBe('>');
    expect(r.conf).toBe(1);
  });

  it('a box holding the row time, garbled, is not a read label either', () => {
    expect(labelRead(key, [at('‹ Wd L9:80', 690)], scale).ok).toBe(false);
  });

  it('the text read by a later crop turns the label into a read one', () => {
    const lines = [at('>', 700), at('Trigger a push notification to Master: call card_block with kind “needs_...', 340)];
    expect(labelRead(key, lines, scale).ok).toBe(true);
  });

  it('text that stays unread still fails, and so does low confidence', () => {
    expect(labelRead(key, [], scale)).toMatchObject({ ok: false, conf: 0 });
    expect(labelRead(key, [at('Trigger a push notification to Master', 340, 0.3)], scale).ok).toBe(false);
  });

  it('look-alike letters are tolerated, other wrong letters are not', () => {
    expect(labelRead(key, [at('Trlgger a push notification to Master', 340)], scale).ok).toBe(true);
    expect(labelRead(key, [at('Wrapper of a pull modification', 340)], scale).ok).toBe(false);
  });

  it('icons and single glyphs are skipped', () => {
    expect(labelRead({ ...key, text: '+' }, [], scale).skip).toBe(true);
  });

  it('the box is the label plus 4 px', () => {
    expect(boxOf(key, scale)).toEqual({ l: 330 * scale - 4, t: 700 * scale - 4, r: 730 * scale + 4, b: 720 * scale + 4 });
  });
});
