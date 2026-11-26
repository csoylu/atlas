/**
 * Markdown → one line of plain text, for places that can't render markdown: system notification banners (#363), from
 * the desktop app and from the web page. Keeps the words, drops the markup: emphasis and code markers, link targets,
 * heading, quote and list markers, table pipes and fences. A task number like « #362 » stays. Whitespace collapses to
 * single spaces; past `max` characters it is cut on a word boundary with « … ».
 */
export function markdownToPlainText(md: string, max = 180): string {
  const code: string[] = [];
  // Code spans first, so their content is kept as is (`a*b` keeps its star).
  const keep = (s: string) => `\uE000${code.push(s) - 1}\uE001`;
  const parts: string[] = [];
  let bullet = false;
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw.trim();
    // Fences, horizontal rules and table separator rows are only markup.
    if (/^(```|~~~)/.test(line) || /^([-*_]\s*){3,}$/.test(line) || /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line)) continue;
    line = line.replace(/`+([^`]+?)`+/g, (_, c: string) => keep(c.trim()));
    line = line.replace(/^(>\s?)+/, '').replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '');
    const item = /^([-*+]|\d+[.)])\s+/.exec(line);
    if (item) line = line.slice(item[0].length);
    if (line.startsWith('|') || line.endsWith('|')) line = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '$1$2')
      .replace(/\*\*|~~|`/g, '');
    if (!line.trim()) {
      bullet = false;
      continue;
    }
    // List items read as « a · b · c »; other lines just follow each other.
    if (parts.length && item && bullet) parts.push(' · ');
    else if (parts.length) parts.push(' ');
    parts.push(line);
    bullet = !!item;
  }
  let out = parts
    .join('')
    .replace(/\uE000(\d+)\uE001/g, (_, i: string) => code[Number(i)]!)
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > max) {
    const cut = out.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    out = `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:·.-]+$/, '')}…`;
  }
  return out;
}
