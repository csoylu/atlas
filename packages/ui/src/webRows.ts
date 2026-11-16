import type { ToolOutcome } from './toolRows.ts';

/**
 * Web tools (#65, mockup pages/chat-activity.html §6): the provider-run web search's results and a fetched page, parsed
 * from what the chat already has (pure, tested). The search result block is turned into the « title\n  url » text the
 * row counts; the fetch output is web_fetch's « URL: …\nTitle: …\n\ntext ».
 */

export interface SearchHit {
  title: string;
  url: string;
  /** "electronjs.org" (no www.). */
  domain: string;
}

/** A web_search_tool_result's content as a tool outcome: the pages found (title and URL), or its error code. */
export function webSearchResult(content: unknown): ToolOutcome {
  if (Array.isArray(content)) {
    const pages = content.flatMap((r: { title?: unknown; url?: unknown }) => (typeof r?.url === 'string' ? [`${typeof r.title === 'string' && r.title.trim() ? oneLine(r.title) : r.url}\n  ${r.url}`] : []));
    return { content: pages.length ? pages.join('\n') : 'no results', isError: false };
  }
  const code = (content as { error_code?: unknown } | null)?.error_code;
  return { content: `web search failed: ${typeof code === 'string' ? code : 'unknown error'}`, isError: true };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "https://www.ex.com/a?b" → "ex.com" (the URL itself when it isn't one). */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url.replace(/^\w+:\/\/(www\.)?/, '').split('/')[0] || url;
  }
}

/** The letter in a result's favicon square. */
export const domainLetter = (domain: string) => (/[a-z0-9]/i.exec(domain)?.[0] ?? '?').toUpperCase();

/** webSearchResult's text back into hits. */
export function searchHits(out: string): SearchHit[] {
  if (out === 'no results') return [];
  const hits: SearchHit[] = [];
  const ls = out.split('\n');
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    if (!l || l.startsWith(' ')) continue;
    const next = ls[i + 1];
    const url = next?.startsWith('  ') ? next.trim() : l;
    hits.push({ title: l, url, domain: domainOf(url) });
  }
  return hits;
}

/** "https://www.electronjs.org/docs/latest/api/tray/" → "electronjs.org/docs/latest/api/tray": the row's object. */
export const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

export interface FetchedPage {
  url: string;
  title?: string;
  /** The page's length in characters (the whole text when the output was cut to its start and end). */
  chars: number;
  /** The start of the text, plain (no markdown marks), ≤ 300 chars. */
  excerpt: string;
}

/** web_fetch's output: its URL and title header, the page size, an excerpt. */
export function fetchedPage(out: string, inputUrl = ''): FetchedPage {
  const url = /^URL: (.*)$/m.exec(out)?.[1]?.trim() || inputUrl;
  const title = /^Title: (.*)$/m.exec(out)?.[1]?.trim() || undefined;
  const headEnd = /^URL: .*\n(Title: .*\n)?\n/.exec(out);
  const text = headEnd ? out.slice(headEnd[0].length) : out;
  const full = /full text \((\d+) chars\) in /.exec(text)?.[1];
  return { url, title, chars: full ? Number(full) : text.length, excerpt: excerptOf(text, title) };
}

/** "12k chars" / "840 chars". */
export const charsText = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k chars` : `${n} chars`);

/** The first paragraphs of light markdown as plain text, without a heading that repeats the title. */
export function excerptOf(text: string, title?: string, max = 300): string {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) =>
      oneLine(
        p
          .replace(/```[\s\S]*?(```|$)/g, ' ')
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/^\s*#+\s*/gm, '')
          .replace(/^\s*[-*]\s+/gm, '')
          .replace(/\*\*|__|`/g, ''),
      ),
    )
    .filter((p) => p && !/^\[(showing|…)/.test(p) && !/^…/.test(p));
  if (title && paras[0] && title.toLowerCase().includes(paras[0].toLowerCase())) paras.shift();
  const s = paras.join(' ');
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s;
}

/** A web tool's failure as a short reason: "HTTP 403", "max uses exceeded", else the error's first line. */
export function webError(content: string): string {
  const first = content.trim().split('\n')[0]!.trim();
  const http = /^HTTP (\d{3})\b/.exec(first);
  if (http) return `HTTP ${http[1]}`;
  const search = /^web search failed: (\S+)/.exec(first);
  if (search) return search[1]!.replace(/_/g, ' ');
  const failed = /^fetch \S+ failed: (.*)$/.exec(first);
  return failed ? failed[1]! : first;
}
