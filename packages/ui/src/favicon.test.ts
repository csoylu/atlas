import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Favicon } from './WebStepDetail.tsx';
import { failedIcons, faviconSrc } from './webRows.ts';

const render = (url: string, domain: string) => renderToString(createElement(Favicon, { url, domain }));

describe('a web result\'s icon (#361)', () => {
  it('asks the engine for the URL\'s own host', () => {
    expect(faviconSrc('https://www.electronjs.org/docs?a=1')).toBe('/api/favicon?domain=www.electronjs.org');
    expect(faviconSrc('ftp://x.org/')).toBeNull();
    expect(faviconSrc('not a url')).toBeNull();
  });

  it('shows the letter while the icon loads, the picture hidden until then', () => {
    const html = render('https://docs.python.org/3/', 'docs.python.org');
    expect(html).toContain('class="web-fav"');
    expect(html).toContain('>D<');
    expect(html).toMatch(/<img src="\/api\/favicon\?domain=docs.python.org" alt=""/);
  });

  it('falls back to the letter alone when the icon failed to load, or there is no host', () => {
    failedIcons.add('/api/favicon?domain=gone.example');
    const html = render('https://gone.example/a', 'gone.example');
    expect(html).toContain('>G<');
    expect(html).not.toContain('<img');
    expect(render('mailto:x', 'x')).not.toContain('<img');
  });
});
