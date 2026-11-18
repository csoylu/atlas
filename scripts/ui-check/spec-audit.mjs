// In-page audit of the #112 visual pass (#104 v2 + the type scale), used by check.mjs on every screen / width / theme.
// Everything is measured from computed styles (what the browser paints), never from the CSS tokens:
//   - font scale: only the 4 size tokens 13 / 14 / 16 / 20 px (plus the commented exceptions below);
//   - contrast: computed text colour over the really painted background, >= 4.5:1 (placeholders / disabled excepted);
//   - spec measures (sidebar 244, rows 32 / 36, header 48, lanes 300, task view 720, chat column 780, pins 40…);
//   - faces: no .dot-avatar shows an initial letter, every one holds the face svg;
//   - status words ("running", "finished"…) are .st-chip, never a plain pill.
// Returns an array of issue strings. Exceptions are listed here, each with its reason, so they stay visible.

export const FONT_SCALE = [13, 14, 16, 20];
// Allowed off-scale sizes (see the "Type scale and rules" section of #112): none by default. Add [selector, size, why].
export const FONT_EXCEPTIONS = [
  // ['.dot-avatar.initial', 11, 'letters inside the smallest avatars if 13 px does not fit'],
  ['input, textarea, select', 16, 'phone inputs at 16 px (iOS zoom)'],
];
export const MIN_CONTRAST = 4.5;

export const SPEC_AUDIT = (W, scale, exceptions, minContrast) => `((W, SCALE, EXC, MINC) => {
  const issues = [];
  const shown = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && +s.opacity > 0.05; };
  const tag = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
  const txt = (e) => (e.value || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30);
  const theme = document.documentElement.dataset.theme || 'dark';

  // ── colours: computed -> [r,g,b,a] (rgb(), rgba() and color(srgb …) are what Chrome returns)
  const parse = (c) => {
    let m = /^rgba?\\(([^)]+)\\)$/.exec(c);
    if (m) { const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = /^color\\(srgb ([^)]+)\\)$/.exec(c);
    if (m) { const p = m[1].split(/[ \\/]+/).filter(Boolean).map(parseFloat); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return null;
  };
  const over = (f, b) => { const a = f[3]; return [f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a), 1]; };
  const lum = ([r, g, b]) => { const l = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  /** The colour really painted behind e: its own and its ancestors' backgrounds composited, up to the first opaque one. */
  const backdrop = (e) => {
    const layers = [];
    for (let p = e; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.backgroundImage !== 'none' && !/^none/.test(s.backgroundImage) && !s.backgroundImage.startsWith('url')) layers.push({ grad: true });
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0) { layers.push({ c }); if (c[3] >= 0.999) break; }
    }
    if (layers.some((l) => l.grad)) return null; // gradients: not measurable here
    let bg = parse(getComputedStyle(document.documentElement).backgroundColor); if (!bg || bg[3] < 1) bg = theme === 'light' ? [255, 255, 255, 1] : [20, 20, 22, 1];
    for (const l of layers.reverse()) bg = over(l.c, bg);
    return bg;
  };
  const opacityOf = (e) => { let o = 1; for (let p = e; p; p = p.parentElement) o *= +getComputedStyle(p).opacity; return o; };

  // ── 1+2: font scale and contrast of every visible text node owner
  const seenSize = new Map();
  const lowContrast = new Map();
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('svg, canvas, [aria-hidden=true], script, style')) continue;
    const input = e.tagName === 'INPUT' || e.tagName === 'TEXTAREA';
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || (input && (e.value || e.placeholder));
    if (!own || !shown(e)) continue;
    const s = getComputedStyle(e);
    const fs = parseFloat(s.fontSize);
    const exc = EXC.find(([sel, size]) => size === fs && e.matches(sel));
    if (!SCALE.includes(fs) && !exc) { const k = fs + 'px ' + tag(e); if (!seenSize.has(k)) seenSize.set(k, '"' + txt(e) + '"'); }
    // contrast
    if (e.disabled || e.closest('[disabled], [aria-disabled=true]')) continue;
    const placeholderOnly = input && !e.value;
    if (placeholderOnly) continue;
    const fg = parse(s.color), bg = backdrop(e);
    if (!fg || !bg) continue;
    // Separators (·, —) carry no information. Dimmed text (opacity < 1: .dim, disabled-looking, fading in) is measured
    // too and reported as « dimmed »; opacity under 0.5 is a transition frame or a hidden control, skipped.
    if (!/[\p{L}\p{N}]/u.test(txt(e))) continue;
    const op = opacityOf(e);
    if (op < 0.5) continue;
    const eff = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const r = ratio(eff, bg);
    if (r < MINC) { const k = tag(e) + ' ' + s.color + (op < 0.99 ? ' x' + op.toFixed(2) : ''); if (!lowContrast.has(k)) lowContrast.set(k, r.toFixed(2) + ':1' + (op < 0.99 ? ' (dimmed, opacity ' + op.toFixed(2) + ')' : '') + ' on rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ') "' + txt(e) + '"'); }
  }
  for (const [k, v] of seenSize) issues.push('font size off the scale ' + k + ' ' + v);
  for (const [k, v] of lowContrast) issues.push('contrast ' + v + ' (' + theme + ') ' + k);

  // ── 3: faces
  for (const a of document.querySelectorAll('.dot-avatar')) {
    if (!shown(a) || a.closest('.sidebar-foot')) continue;
    if (!a.querySelector('svg')) issues.push('avatar without face: ' + tag(a) + ' "' + txt(a) + '"');
    else if ([...a.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) issues.push('avatar shows a letter next to the face: ' + tag(a) + ' "' + txt(a) + '"');
  }

  // ── 4: measures (px) — only when the element is on this screen
  const phone = W <= 900;
  const want = (sel, prop, val, label, tol = 0.6) => {
    for (const e of [...document.querySelectorAll(sel)].filter(shown).slice(0, 3)) {
      const r = e.getBoundingClientRect(); const got = prop === 'h' ? r.height : prop === 'w' ? r.width : parseFloat(getComputedStyle(e)[prop]);
      if (Math.abs(got - val) > tol) { issues.push(label + ': ' + got.toFixed(1) + 'px, spec ' + val + 'px (' + tag(e) + ')'); break; }
    }
  };
  if (!phone) want('.sidebar', 'w', 244, 'sidebar width');
  want('.nav-item:not(.agent-item)', 'h', phone ? 40 : 32, 'nav row height');
  want('.nav-item.agent-item', 'h', phone ? 44 : 36, 'agent row height');
  want('.nav-item.agent-item .dot-avatar', 'w', 22, 'sidebar avatar');
  want('.chat-hist-item .dot-avatar', 'w', 18, 'history avatar');
  want('.screen-head', 'h', 48, 'screen header height');
  want('.crumb .dot-avatar', 'w', 24, 'chat header avatar');
  want('.msg .who .dot-avatar', 'w', 20, 'message avatar');
  want('.card-top .dot-avatar', 'w', 20, 'card avatar');
  want('.chat-row.steps > .chat-row-line, .chat-row.nested > .chat-row-line', 'h', matchMedia('(pointer: coarse)').matches ? 44 : 36, 'step row height', 1.5);
  want('.chat-pin', 'h', matchMedia('(pointer: coarse)').matches ? 44 : 40, 'pinned task height');
  if (!phone) want('.column', 'w', 300, 'board lane width');
  if (W > 760) want('.card-modal', 'w', 720, 'task view width');
  if (!phone) for (const e of document.querySelectorAll('.chat-pane .composer')) { if (shown(e) && e.getBoundingClientRect().width > 781) { issues.push('composer wider than the 780 px column: ' + Math.round(e.getBoundingClientRect().width)); break; } }

  // ── 5: status words are chips
  for (const e of document.querySelectorAll('.cm-pill')) if (shown(e) && /^(running|blocked|done|review|working)/i.test(txt(e)) && !e.classList.contains('st-chip') && !e.closest('.prop-pill')) issues.push('status pill is not a .st-chip: "' + txt(e) + '"');
  for (const e of document.querySelectorAll('.chat-row.card-report')) if (shown(e) && /finished/i.test(e.textContent) && !e.querySelector('.st-chip')) issues.push('finished report without Done chip: "' + txt(e) + '"');
  for (const e of document.querySelectorAll('.st-chip')) if (shown(e) && /^running$/i.test(txt(e))) issues.push('chip says "running", should say Working');
  for (const e of document.querySelectorAll('.st-chip')) if (shown(e)) { const a = getComputedStyle(e, '::before'); if (a.animationName !== 'none') issues.push('chip dot pulses (' + a.animationName + ')'); }

  return issues;
})(${W}, ${JSON.stringify(scale)}, ${JSON.stringify(exceptions)}, ${minContrast})`;
