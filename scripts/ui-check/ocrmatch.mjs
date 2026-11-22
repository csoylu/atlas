// Matching a key label against what Apple Vision read in its box (used by check.mjs, tested in ocrmatch.test.ts, #343).

export const MIN_CONF = 0.5;
// Vision sometimes answers with Cyrillic / Greek look-alikes (« Аpp »): fold them to Latin before comparing.
const LOOKALIKE = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', α: 'a', ο: 'o', ν: 'v', ρ: 'p', τ: 't', ι: 'i', κ: 'k' };
// In Inter a capital I and a lowercase l are the same glyph, so OCR reads either: compare them as one letter.
// OCR also reads a lowercase i as a capital I (« Links » → « LInks », a tab at 900 px, #225), so i, I and l count as one
// letter. A narrow tolerance: only these three letters, only when comparing; every other letter must match.
export const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/./g, (c) => LOOKALIKE[c] ?? c).replace(/[il]/g, 'l').replace(/[^a-z0-9]/g, '');

/** Smallest edit distance between `p` and any substring of `t` (approximate substring match). */
export function fuzzy(p, t) {
  let prev = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= p.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p[i - 1] === t[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(...prev);
}

/** The label's box in image pixels (4 px around its css box). */
export const boxOf = (k, scale) => ({ l: k.x * scale - 4, t: k.y * scale - 4, r: (k.x + k.w) * scale + 4, b: (k.y + k.h) * scale + 4 });
/** A Vision line whose middle is in the box's rows and that overlaps its columns. */
export const inBox = (o, box) => o.y + o.h / 2 >= box.t && o.y + o.h / 2 <= box.b && o.x < box.r && o.x + o.w > box.l;

/**
 * What Vision read for a key label `k` (css px box, `shown` = visible share of the text) among `lines` (image px):
 * `skip` for an icon or glyph, else the text read, its best confidence and `ok` = the start of the label is in it
 * (edit distance ≤ 20%) with confidence ≥ MIN_CONF.
 * A line in the box is not a read label: a row's chevron or timestamp alone is in the box when Vision drops the text
 * between them (#343: read ">" for « Trigger a push notification… », 1100 px). `ok` is what tells a label read from a
 * box that only holds its neighbours.
 */
export function labelRead(k, lines, scale) {
  const box = boxOf(k, scale);
  const hit = lines.filter((o) => inBox(o, box));
  const read = hit.map((o) => o.text).join(' ');
  const full = norm(k.text);
  const want = full.slice(0, Math.min(12, Math.floor(full.length * Math.min(1, k.shown)) - 1));
  if (want.length < 2) return { skip: true, read, conf: 0, ok: true };
  const conf = hit.length ? Math.max(...hit.map((o) => o.conf)) : 0;
  const ok = fuzzy(want, norm(read)) <= Math.floor(want.length / 5) && conf >= MIN_CONF;
  return { skip: false, read, conf, ok };
}
