import { describe, expect, it } from 'vitest';
import { charsText, domainLetter, domainOf, excerptOf, fetchedPage, searchHits, shortUrl, webError, webSearchResult } from './webRows.ts';

describe('web search', () => {
  it('turns the result block into text and back into hits', () => {
    const out = webSearchResult([
      { type: 'web_search_result', url: 'https://www.electronjs.org/docs/latest/api/tray', title: 'Tray | Electron', encrypted_content: 'e' },
      { type: 'web_search_result', url: 'https://github.com/x', title: '  Multi\nline  ', encrypted_content: 'e' },
      { type: 'web_search_result', url: 'https://ex.com/a', title: '', encrypted_content: 'e' },
      { type: 'other' },
    ]);
    expect(out.isError).toBe(false);
    expect(searchHits(out.content)).toEqual([
      { title: 'Tray | Electron', url: 'https://www.electronjs.org/docs/latest/api/tray', domain: 'electronjs.org' },
      { title: 'Multi line', url: 'https://github.com/x', domain: 'github.com' },
      { title: 'https://ex.com/a', url: 'https://ex.com/a', domain: 'ex.com' },
    ]);
  });

  it('empty and failed searches', () => {
    expect(webSearchResult([])).toEqual({ content: 'no results', isError: false });
    expect(searchHits('no results')).toEqual([]);
    expect(webSearchResult({ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' })).toEqual({ content: 'web search failed: max_uses_exceeded', isError: true });
    expect(webSearchResult(null).isError).toBe(true);
  });

  it('domains and their letter', () => {
    expect(domainOf('https://www.Example.com:8080/a?b')).toBe('example.com');
    expect(domainOf('not a url/x')).toBe('not a url');
    expect(domainLetter('electronjs.org')).toBe('E');
    expect(domainLetter('-')).toBe('?');
    expect(shortUrl('https://www.electronjs.org/docs/tray/')).toBe('electronjs.org/docs/tray');
  });
});

describe('web fetch', () => {
  it('reads the header, the size and an excerpt', () => {
    const out = 'URL: https://www.electronjs.org/docs/latest/api/tray\nTitle: Tray | Electron\n\n# Tray\n\nAdd icons and **context menus** to the [notification area](https://x/y).\n\n- one\n- two';
    expect(fetchedPage(out)).toEqual({
      url: 'https://www.electronjs.org/docs/latest/api/tray',
      title: 'Tray | Electron',
      chars: out.length - out.indexOf('# Tray'),
      excerpt: 'Add icons and context menus to the notification area. one two',
    });
  });

  it('counts the whole page when the output was cut', () => {
    const out = 'URL: https://e.com\n\nstart\n\n[… 9120 chars omitted; full text (24120 chars) in /x/web-1.md: read_file it …]\n\nend';
    const p = fetchedPage(out, 'https://e.com/in');
    expect(p).toMatchObject({ url: 'https://e.com', title: undefined, chars: 24120, excerpt: 'start end' });
    expect(charsText(p.chars)).toBe('24k chars');
    expect(charsText(840)).toBe('840 chars');
  });

  it('cuts the excerpt at a word', () => {
    const e = excerptOf('word '.repeat(200));
    expect(e.length).toBeLessThanOrEqual(300);
    expect(e.endsWith('word…')).toBe(true);
  });

  it('short failure reasons', () => {
    expect(webError('HTTP 403 from https://example.com/private: Forbidden')).toBe('HTTP 403');
    expect(webError('web search failed: max_uses_exceeded')).toBe('max uses exceeded');
    expect(webError('fetch https://x failed: getaddrinfo ENOTFOUND x')).toBe('getaddrinfo ENOTFOUND x');
    expect(webError('only http(s) URLs can be fetched, not ftp:')).toBe('only http(s) URLs can be fetched, not ftp:');
  });
});
