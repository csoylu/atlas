/** web_fetch: a page as readable text (HTML → light markdown). Web search is provider-native (providers/*.ts). */

const MAX_BYTES = 10_000_000;
const TIMEOUT_MS = 30_000;

export interface Page {
  url: string;
  status: number;
  contentType: string;
  title: string | null;
  text: string;
  /** The bytes, when the URL is a picture (content-type image/png|jpeg|gif|webp); `text` is then empty. */
  image?: Buffer;
}

const MAX_HOPS = 10;

/**
 * Fetch `url` and follow its redirects by hand (at most MAX_HOPS), so `allow` sees every hop (#298 §2.3: the workspace's
 * internet level): it returns why a URL may not be fetched, or null. A refused hop stops the fetch with that reason.
 */
export async function fetchPage(url: string, signal: AbortSignal, fetchFn: typeof fetch = fetch, allow?: (u: URL) => string | null): Promise<Page> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  let res: Response;
  for (let hop = 0; ; hop++) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http(s) URLs can be fetched, not ${u.protocol}`);
    const why = allow?.(u);
    if (why) throw new Error(hop ? `${url} redirects to ${u.href}: ${why}` : why);
    try {
      res = await fetchFn(u, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Atlas agent)', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
      });
    } catch (e) {
      signal.throwIfAborted();
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e);
      throw new Error(`fetch ${url} failed: ${cause}`);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) break;
    await res.body?.cancel();
    if (hop + 1 >= MAX_HOPS) throw new Error(`fetch ${url} failed: more than ${MAX_HOPS} redirects`);
    try {
      u = new URL(location, u);
    } catch {
      throw new Error(`fetch ${url} failed: bad redirect to ${location}`);
    }
  }
  url = res.url || u.href;
  const contentType = res.headers.get('content-type') ?? '';
  const buf = await readCapped(res);
  if (/^image\/(png|jpeg|gif|webp)\b/i.test(contentType)) {
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    if (buf.truncated) throw new Error(`${url} is an image over ${MAX_BYTES / 1_000_000} MB: images that big are refused`);
    return { url: res.url || url, status: res.status, contentType, title: null, text: '', image: buf };
  }
  const textual = !contentType || /^text\/|json|xml|javascript|markdown|yaml|csv/i.test(contentType);
  if (!textual) throw new Error(`${url} is not text (content-type ${contentType}, ${buf.length} bytes)`);
  const raw = buf.toString('utf8');
  const html = /html/i.test(contentType) || (!contentType && /^\s*<(!doctype html|html)/i.test(raw));
  const page = html ? htmlToMarkdown(raw, res.url || url) : { title: null, text: raw };
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${page.text.trim().slice(0, 500)}`);
  return { url: res.url || url, status: res.status, contentType, ...page };
}

async function readCapped(res: Response): Promise<Buffer & { truncated?: boolean }> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of res.body) {
    const b = Buffer.from(c as Uint8Array);
    chunks.push(b);
    n += b.length;
    if (n > MAX_BYTES) break;
  }
  const out: Buffer & { truncated?: boolean } = Buffer.concat(chunks).subarray(0, MAX_BYTES);
  if (n > MAX_BYTES) out.truncated = true;
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', euro: '€', times: '×',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ''));

/** A light HTML → markdown: headings, links, lists, code, emphasis, tables as rows; scripts, styles and chrome dropped. */
export function htmlToMarkdown(html: string, baseUrl?: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form|button|select)\b[\s\S]*?<\/\1\s*>/gi, '');
  // The page's main content when it says where it is.
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(s)?.[1] ?? /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(s)?.[1];
  if (main && stripTags(main).trim().length > 200) s = main;
  // Code blocks keep their whitespace: replaced by placeholders until the end.
  const pres: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner: string) => {
    pres.push('```\n' + stripTags(inner.replace(/<br\s*\/?>/gi, '\n')).replace(/\n+$/, '') + '\n```');
    return `\n\n\u0000${pres.length - 1}\u0000\n\n`;
  });
  const abs = (href: string) => {
    try {
      return baseUrl ? new URL(decodeEntities(href), baseUrl).href : decodeEntities(href);
    } catch {
      return href;
    }
  };
  s = s
    .replace(/\s+/g, ' ')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${stripTags(t).trim()}\n\n`)
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, t: string) => {
      const label = stripTags(t).trim();
      if (!label) return '';
      return href.startsWith('#') || href.startsWith('javascript:') ? label : `[${label}](${abs(href)})`;
    })
    .replace(/<img\b[^>]*?alt\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, alt: string) => `[image: ${alt}]`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, t: string) => '`' + t + '`')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _t: string, t: string) => `**${t}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _t: string, t: string) => `_${t}_`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<\/?(p|div|section|article|header|aside|main|ul|ol|table|tr|thead|tbody|blockquote|dl|dt|dd|figure|figcaption|hr)\b[^>]*>/gi, '\n\n');
  s = stripTags(s)
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/(\| ){2,}/g, '| ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => pres[Number(i)]!)
    .trim();
  return { title: title ? stripTags(title).trim() || null : null, text: s };
}

/** Head + tail of a long text, with what was cut in between. */
export function headTail(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[… ${text.length - max} chars omitted; ${note} …]\n\n${text.slice(text.length - tail)}`;
}
