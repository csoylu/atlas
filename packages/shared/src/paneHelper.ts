/*
 * Comment mode on an html page (#304). A page in the pane runs in a sandboxed frame with no access to the app, and
 * the app none to it, so the engine adds this small script to the pages it serves with `?pane=1` (and the UI to an
 * old version's srcdoc). It talks to the app by postMessage only: the app says « comment mode on/off » and which marks
 * to draw; the page answers what was clicked (an element: selector, text, tag) or dragged (an area in the page's own
 * CSS px, and the elements inside it). The page's own clicks are held back while comment mode is on.
 */

/**
 * A CSS selector that finds this element again from `root` (the document, or an svg): ids when there are, else
 * tag.class:nth-of-type steps, at most 5. Self-contained: it is also sent as text into the page's frame.
 */
export function cssPath(el: Element, root: Element): string {
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => '\\' + c));
  const steps: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== root && steps.length < 5) {
    const tag = cur.tagName.toLowerCase();
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      steps.unshift(tag + '#' + esc(cur.id));
      break;
    }
    let step = tag;
    const cls = typeof cur.className === 'string' ? cur.className.trim().split(/\s+/).filter((c) => c && !c.startsWith('atlas-')).slice(0, 2) : [];
    if (cls.length) step += '.' + cls.map(esc).join('.');
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === cur!.tagName);
      if (same.length > 1) step += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    steps.unshift(step);
    cur = parent;
  }
  if (cur === root) steps.unshift(root.tagName.toLowerCase() === 'svg' ? 'svg' : 'body');
  return steps.join(' > ');
}

/** The script added to a page in the pane (one IIFE; `cssPath` above is inlined as text). */
export const PANE_HELPER = `(() => {
if (window.__atlasPane || window.parent === window) return;
window.__atlasPane = 1;
const __name = (f) => f;
const cssPath = ${cssPath.toString()};
const P = window.parent;
const send = (m) => P.postMessage(Object.assign({ atlasPane: 1 }, m), '*');
let on = false, marks = [], down = null, hover = null;
const de = document.documentElement;
const layer = document.createElement('div');
layer.className = 'atlas-pane-layer';
layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
const style = document.createElement('style');
style.textContent = '.atlas-pane-on,.atlas-pane-on *{cursor:crosshair!important}.atlas-pane-hover{outline:2px solid #4fb8d0!important;outline-offset:1px!important}'
  + '.atlas-pane-layer>div{position:absolute;box-sizing:border-box}'
  + '.atlas-pane-area{border:2px dashed #4fb8d0;background:rgba(79,184,208,.12);border-radius:4px}'
  + '.atlas-pane-hl{outline:2px solid #4fb8d0;border-radius:4px}'
  + '.atlas-pane-pin{width:24px;height:24px;margin:-24px 0 0 -2px;border-radius:12px 12px 12px 2px;background:#4fb8d0;color:#0b1d22;font:600 13px/24px system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3)}';
const mount = () => { if (!layer.isConnected) (document.body || de).appendChild(layer); if (!style.isConnected) (document.head || de).appendChild(style); };
const size = () => ({ w: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0, 1), h: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, 1) });
const text = (el) => ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 400);
const box = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
const view = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
const ours = (el) => !el || el === layer || layer.contains(el);
const draw = () => {
  mount();
  layer.textContent = '';
  for (const m of marks) {
    if (m.style !== 'pin') {
      const a = document.createElement('div');
      a.className = m.style === 'area' ? 'atlas-pane-area' : 'atlas-pane-hl';
      a.style.cssText = 'left:' + m.box.x + 'px;top:' + m.box.y + 'px;width:' + m.box.w + 'px;height:' + m.box.h + 'px';
      layer.appendChild(a);
    }
    const p = document.createElement('div');
    p.className = 'atlas-pane-pin';
    p.textContent = String(m.n);
    p.style.left = m.box.x + 'px';
    p.style.top = m.box.y + 'px';
    layer.appendChild(p);
  }
};
const setHover = (el) => { if (hover) hover.classList.remove('atlas-pane-hover'); hover = el; if (el) el.classList.add('atlas-pane-hover'); };
addEventListener('message', (e) => {
  if (e.source !== P || !e.data || !e.data.atlasPane) return;
  if ('on' in e.data) { on = !!e.data.on; de.classList.toggle('atlas-pane-on', on); if (!on) { setHover(null); down = null; } }
  if (e.data.marks) { marks = e.data.marks; draw(); }
  if (e.data.hello) send({ ready: 1 });
});
const stop = (e) => { if (!on) return; e.preventDefault(); e.stopPropagation(); };
for (const t of ['click', 'dblclick', 'auxclick', 'submit', 'mousedown', 'mouseup', 'contextmenu']) addEventListener(t, stop, true);
addEventListener('pointerdown', (e) => { if (!on || e.button !== 0) return; stop(e); down = { x: e.clientX, y: e.clientY, moved: false }; }, true);
addEventListener('pointermove', (e) => {
  if (!on) return;
  if (down) {
    if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) down.moved = true;
    if (down.moved) {
      setHover(null);
      const x = Math.min(down.x, e.clientX), y = Math.min(down.y, e.clientY);
      marks = marks.filter((m) => !m.live).concat([{ n: '', live: 1, style: 'area', box: { x: x + scrollX, y: y + scrollY, w: Math.abs(e.clientX - down.x), h: Math.abs(e.clientY - down.y) } }]);
      draw();
    }
    return;
  }
  const el = document.elementFromPoint(e.clientX, e.clientY);
  setHover(ours(el) || el === de || el === document.body ? null : el);
}, true);
addEventListener('pointerup', (e) => {
  if (!on || !down) return;
  stop(e);
  const d = down; down = null;
  marks = marks.filter((m) => !m.live);
  if (d.moved) {
    const r = { left: Math.min(d.x, e.clientX), top: Math.min(d.y, e.clientY), width: Math.abs(e.clientX - d.x), height: Math.abs(e.clientY - d.y) };
    const inside = [];
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      if (ours(el) || inside.length >= 12) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || b.left < r.left || b.top < r.top || b.right > r.left + r.width || b.bottom > r.top + r.height) continue;
      if (inside.some((s) => s.el.contains(el))) continue;
      const t = text(el);
      if (t || /^(img|svg|input|button|select|textarea|video|canvas)$/i.test(el.tagName)) inside.push({ el, selector: cssPath(el, document.body), text: t.slice(0, 120) });
    }
    send({ pick: { anchor: { type: 'area', box: box(r), of: size(), unit: 'px', inside: inside.map((s) => ({ selector: s.selector, text: s.text })) }, rect: view(r), mark: { style: 'area', box: box(r) } } });
  } else {
    const el = document.elementFromPoint(d.x, d.y);
    if (!el || ours(el)) return;
    const r = el.getBoundingClientRect();
    if (el === de || el === document.body) {
      const p = { left: d.x, top: d.y, width: 0, height: 0 };
      send({ pick: { anchor: { type: 'spot', x: d.x + scrollX, y: d.y + scrollY, of: size(), unit: 'px', under: null }, rect: view(p), mark: { style: 'pin', box: box(p) } } });
    } else send({ pick: { anchor: { type: 'element', selector: cssPath(el, document.body), text: text(el), tag: el.tagName.toLowerCase() }, rect: view(r), mark: { style: 'hl', box: box(r) } } });
  }
  draw();
}, true);
addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
  if (e.key === 'Escape' && on) { e.preventDefault(); send({ key: 'Escape' }); }
  else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'C')) send({ key: 'c' });
}, true);
send({ ready: 1 });
})();`;

/** A page's html with the helper added (before </body>, else at the end). */
export function withPaneHelper(html: string): string {
  const tag = `<script>${PANE_HELPER}</script>`;
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i < 0 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}
