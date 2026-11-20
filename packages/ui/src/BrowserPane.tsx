// The chat's browser in the pane (#306, mockup « the right pane as a workbench » › Browser; behaviour #298 §3): the
// bar (back, forward, reload or stop, the address, who drives), the strips (needs you, opened from a link, the agent
// is acting), the states (empty, blocked by the workspace's internet setting, crashed, a load that failed) and the
// page itself, which is not DOM: the desktop app lays a native view over `.wb-view` (PUT /api/browser/view). The
// agent's pulse, caption and accent edge are drawn by the desktop over the page (apps/desktop/src/browser.ts).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { isDriving, networkRefusal, normalizeAddress, type BrowserShot, type BrowserStatus, type BrowserTab } from '@atlas/shared';
import { api } from './api.ts';
import { browserTitle, hostOf, recentPages, whenText } from './browserTab.ts';
import { Icon } from './ScreenHeader.tsx';
import { AgentFace } from './AgentFace.tsx';
import { PickOverlay, Marks, type PaneComment } from './CommentLayer.tsx';
import { contains, type Box, type PanePick } from './comments.ts';

/** Whether this engine has a browser (the desktop app): asked once per page load. */
let statusOnce: Promise<BrowserStatus> | null = null;
export function useBrowserStatus(): BrowserStatus | null {
  const [s, setS] = useState<BrowserStatus | null>(null);
  useEffect(() => {
    let live = true;
    statusOnce ??= api.browserStatus().catch((e: unknown) => ({ available: false, reason: e instanceof Error ? e.message : String(e) }));
    void statusOnce.then((v) => live && setS(v));
    return () => {
      live = false;
    };
  }, []);
  return s;
}
/** Tests: forget the cached status. */
export const resetBrowserStatus = () => void (statusOnce = null);


/** True while the agent is driving; turns false by itself DRIVING_MS after its last action. */
export function useDriving(tab: BrowserTab | null | undefined): boolean {
  const [, tick] = useState(0);
  const on = !!tab && isDriving(tab);
  useEffect(() => {
    if (!on || !tab?.action) return;
    const left = Date.parse(tab.action.at) + 20_000 - Date.now();
    const t = setTimeout(() => tick((n) => n + 1), Math.max(50, left + 50));
    return () => clearTimeout(t);
  }, [on, tab?.action]);
  return on;
}

/** The address as the bar shows it: no scheme, the host brighter (mockup). */
function Address({ url }: { url: string }) {
  let host = '';
  let rest = url;
  try {
    const u = new URL(url);
    host = u.host;
    rest = (u.pathname === '/' && !u.search ? '' : u.pathname) + u.search + u.hash;
  } catch {
    /* not a full address: shown as it is */
  }
  return (
    <span className="u" title={url}>
      <span className="h">{host}</span>
      {rest}
    </span>
  );
}

/** Elements over the page that the native view would hide: menus, dialogs, tooltips. */
const OVER = '.head-pop, [role=dialog], [role=menu], .wb-tip, .palette, .toast';

/**
 * The view's place: the bounds of `.wb-view` while it shows a live page, else none (the desktop hides the view). An
 * element of Atlas over it (a menu, a dialog) hides it too: a native view is always on top.
 */
function useViewBounds(chatId: string, el: React.RefObject<HTMLDivElement | null>, live: boolean, onError: (e: unknown) => void) {
  useLayoutEffect(() => {
    if (!live) return;
    let last = '';
    let frame = 0;
    const send = () => {
      frame = 0;
      const v = el.current;
      if (!v) return;
      const r = v.getBoundingClientRect();
      const covered = [...document.querySelectorAll(OVER)].some((o) => {
        const b = o.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top && !v.contains(o);
      });
      const shown = r.width > 0 && r.height > 0 && !covered && document.visibilityState === 'visible';
      const bounds = shown ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : null;
      const key = JSON.stringify(bounds);
      if (key === last) return;
      last = key;
      void api.browserView(bounds ? chatId : null, bounds).catch(onError);
    };
    const soon = () => void (frame ||= requestAnimationFrame(send));
    soon();
    const ro = new ResizeObserver(soon);
    if (el.current) ro.observe(el.current);
    const mo = new MutationObserver(soon);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', soon);
    document.addEventListener('visibilitychange', soon);
    // The pane slides in (transitions) and its resizer moves it: follow the box for a while after each change.
    const iv = setInterval(soon, 500);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      clearInterval(iv);
      window.removeEventListener('resize', soon);
      document.removeEventListener('visibilitychange', soon);
      void api.browserView(null, null).catch(onError);
    };
  }, [chatId, el, live, onError]);
}

export function BrowserPane(props: {
  chatId: string;
  tab: BrowserTab;
  /** The chat's agent (null: Master's own pane, which no agent drives). */
  agentId: string | null;
  status: BrowserStatus | null;
  phone: boolean;
  /** The pane is narrower than 520 px: short labels (mockup). */
  tight: boolean;
  /** Master's click was refused while the agent acts (a moment, then it goes). */
  blockedAt: number;
  comment?: PaneComment;
  commenting: boolean;
  onError(e: unknown): void;
}) {
  const { chatId, tab, agentId, onError } = props;
  const agent = tab.agentId ?? agentId;
  const driving = useDriving(tab);
  const view = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const addr = useRef<HTMLInputElement>(null);
  const available = !!props.status?.available;
  const refusal = networkRefusal(tab.error);
  const state: 'unavailable' | 'empty' | 'blocked' | 'crash' | 'failed' | 'page' = !available
    ? 'unavailable'
    : !tab.url
      ? 'empty'
      : refusal
        ? 'blocked'
        : tab.crashed
          ? 'crash'
          : tab.error && !tab.loading
            ? 'failed'
            : 'page';
  // Comment mode freezes the page on a picture of it (the native view can't take pins): picked on that picture.
  const [shot, setShot] = useState<BrowserShot | null>(null);
  const freeze = props.commenting && state === 'page';
  useEffect(() => {
    if (!freeze) return setShot(null);
    let live = true;
    api.browserShot(chatId).then((s) => live && setShot(s), onError);
    return () => {
      live = false;
    };
  }, [freeze, chatId, onError]);
  useViewBounds(chatId, view, available && state === 'page' && !freeze, onError);
  // The blocked strip shows for a moment after Master's refused click.
  const [blockedNow, setBlockedNow] = useState(false);
  useEffect(() => {
    if (!props.blockedAt) return;
    setBlockedNow(true);
    const t = setTimeout(() => setBlockedNow(false), 3000);
    return () => clearTimeout(t);
  }, [props.blockedAt]);
  // An empty tab: the address bar takes the focus (mockup: empty state).
  useEffect(() => {
    if (state === 'empty' && !props.phone) addr.current?.focus();
  }, [state, props.phone]);
  const owner = (o: 'agent' | 'master') => void api.browserOwner(chatId, o).catch(onError);
  const nav = (a: 'back' | 'forward' | 'reload' | 'stop') => void api.browserNav(chatId, a).catch(onError);
  const go = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setTyped(null);
    addr.current?.blur();
    void api.browserOpen(chatId, normalizeAddress(t), 'typed').catch(onError);
  };
  const tight = props.tight;
  const needs = tab.needs && tab.owner === 'agent';
  let driver: ReactNode = null;
  if (agent && tab.owner === 'agent' && tab.agentUsed)
    driver = (
      <span className="wb-driver" title={`${agent} is driving`}>
        <AgentFace id={agent} />
        {!tight && <span>{agent} is driving</span>}
        {!needs && (
          <button type="button" className="btn small" title="Your clicks and keys go to the page; the agent waits" onClick={() => owner('master')}>
            {tight ? 'Take over' : 'Take control'}
          </button>
        )}
      </span>
    );
  else if (agent && tab.owner === 'master' && tab.agentUsed)
    driver = (
      <span className="wb-driver">
        <span className="you">{tight ? 'You' : 'You’re driving'}</span>
        <button type="button" className="btn small" title={`${agent} gets the page as it is now`} onClick={() => owner('agent')}>
          {tight ? 'Hand back' : `Hand back to ${agent}`}
        </button>
      </span>
    );
  const secure = tab.url?.startsWith('https://');
  return (
    <div className="wb-browser" data-browser-chat={chatId}>
      <div className="wb-bar">
        <button type="button" className="sd-btn icon-only" title="Back" aria-label="Back" disabled={!available || !tab.url} onClick={() => nav('back')}>
          <Icon.back />
        </button>
        {!props.phone && (
          <button type="button" className="sd-btn icon-only" title="Forward" aria-label="Forward" disabled={!available || !tab.url} onClick={() => nav('forward')}>
            <Icon.fwd />
          </button>
        )}
        {tab.loading ? (
          <button type="button" className="sd-btn icon-only" title="Stop" aria-label="Stop" onClick={() => nav('stop')}>
            <Icon.stop />
          </button>
        ) : (
          <button type="button" className="sd-btn icon-only" title="Reload" aria-label="Reload" disabled={!available || !tab.url} onClick={() => nav('reload')}>
            <Icon.reload />
          </button>
        )}
        <label className={'wb-addr' + (typed !== null ? ' focus' : '')}>
          {secure && typed === null && <Icon.lock />}
          {typed === null && tab.url && (
            // The address as read (host brighter); a click turns it into the field.
            <span className="wb-addr-show" aria-hidden="true">
              <Address url={tab.url} />
            </span>
          )}
          <input
            ref={addr}
            className={typed === null && tab.url ? 'wb-addr-in quiet' : 'wb-addr-in'}
            value={typed ?? tab.url ?? ''}
            placeholder="Type an address"
            aria-label="Address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={!available}
            onFocus={(e) => {
              setTyped(tab.url ?? '');
              requestAnimationFrame(() => e.target.select());
            }}
            onBlur={() => setTyped(null)}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go(e.currentTarget.value);
              else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setTyped(null);
                e.currentTarget.blur();
              }
            }}
          />
        </label>
        {driver}
        {tab.loading && <span className="wb-progress" aria-hidden="true" />}
      </div>
      {needs && agent && (
        <div className="wb-strip warn" role="status">
          <Icon.warn />
          <span className="grow">
            <b>{agent} needs you</b> {needsText(tab.needs!)} Take control, then hand it back. {agent} doesn’t see what you type.
          </span>
          <button type="button" className="btn small primary" onClick={() => owner('master')}>
            Take control
          </button>
        </div>
      )}
      {blockedNow && agent && !needs && (
        <div className="wb-strip" role="status">
          <AgentFace id={agent} />
          <span className="grow">{agent} is using the browser. Take control to use it yourself.</span>
        </div>
      )}
      {tab.via === 'link' && state === 'page' && !needs && !blockedNow && (
        <div className="wb-strip acc">
          <span className="grow">Opened from your link in the chat.</span>
          <a className="btn small ghost" href={tab.url ?? '#'} target="_blank" rel="noreferrer" data-external="1">
            <Icon.ext /> Open in system browser
          </a>
        </div>
      )}
      <div className={'wb-view' + (driving ? ' agent' : '') + (freeze ? ' frozen' : '')} ref={view}>
        {state === 'page' && freeze && <FrozenPage shot={shot} comment={props.comment} />}
        {state === 'empty' && <EmptyState chatId={chatId} agent={agent} onOpen={go} onError={onError} />}
        {state === 'blocked' && (
          <div className="wb-empty">
            <span className="big">
              <Icon.wifiOff />
            </span>
            <b>{refusal === 'offline' ? `No internet for ${agent ?? 'this tab'} in this workspace` : `${hostOf(tab.url!)} is blocked in this workspace`}</b>
            <p>
              {refusal === 'offline'
                ? `This workspace can reach only localhost. ${hostOf(tab.url!)} is blocked by its network setting.`
                : `${hostOf(tab.url!)} is not in the hosts this workspace’s network setting allows.`}
            </p>
            <div className="row">
              {tab.projectId && (
                <a className="btn small" href={'#/settings/projects/' + encodeURIComponent(tab.projectId)}>
                  Network setting
                </a>
              )}
            </div>
          </div>
        )}
        {(state === 'crash' || state === 'failed') && (
          <div className="wb-empty">
            <span className="big">{state === 'crash' ? <Icon.crash /> : <Icon.warn />}</span>
            <b>{state === 'crash' ? 'The page stopped working' : 'The page could not be loaded'}</b>
            <p>{state === 'crash' ? 'The browser of this chat crashed. Its cookies and history are kept.' : tab.error}</p>
            <div className="row">
              <button type="button" className="btn small primary" onClick={() => nav('reload')}>
                Reload
              </button>
            </div>
          </div>
        )}
        {state === 'unavailable' && (
          <div className="wb-empty">
            {props.status ? (
              <span className="big">
                <Icon.globe />
              </span>
            ) : (
              <span className="wb-spin" aria-hidden="true" />
            )}
            <b>{props.status ? 'The browser runs in the Atlas app' : 'Connecting to the browser…'}</b>
            <p>{props.status ? (props.status.reason ?? 'Open Atlas on your Mac to see this page.') : ''}</p>
            {props.status && tab.url && (
              <div className="row">
                <a className="btn small" href={tab.url} target="_blank" rel="noreferrer">
                  <Icon.ext /> Open {hostOf(tab.url)} in a new tab
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


/** « to sign in to github.com. » from the agent's reason (browser_ask): ends with a full stop. */
function needsText(why: string): string {
  const t = why.trim().replace(/\s+/g, ' ');
  return /[.!?]$/.test(t) ? t : t + '.';
}

/** No page yet: the address bar is focused; the pages this agent's browser opened lately, one click away. */
function EmptyState({ chatId, agent, onOpen, onError }: { chatId: string; agent: string | null; onOpen(url: string): void; onError(e: unknown): void }) {
  const [recent, setRecent] = useState<BrowserTab[]>([]);
  useEffect(() => {
    let live = true;
    api.browserTabs().then(
      (ts) => live && setRecent(ts),
      onError,
    );
    return () => {
      live = false;
    };
  }, [chatId, agent, onError]);
  const list = recentPages(recent, chatId, agent);
  return (
    <div className="wb-empty">
      <span className="big">
        <Icon.globe />
      </span>
      <b>No page open</b>
      <p>Type an address above or click a link in the chat.{agent ? ` ${agent} can open pages here too.` : ''}</p>
      {!!list.length && (
        <div className="wb-recent">
          {list.map((t) => (
            <button key={t.chatId} type="button" title={t.url!} onClick={() => onOpen(t.url!)}>
              <Icon.globe />
              <span className="t">{t.url!.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
              <span className="m">{whenText(t.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * Comment mode on a page (#306): the picture of the page as it was when comment mode started; a click asks the page
 * what element is there, a drag what is inside the area (POST …/inspect), in CSS px of the page's viewport.
 */
function FrozenPage({ shot, comment }: { shot: BrowserShot | null; comment?: PaneComment }) {
  const img = useRef<HTMLImageElement>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [shot]);
  if (!shot) return <div className="wb-skel" aria-label="Taking a picture of the page" />;
  const shown = img.current?.getBoundingClientRect();
  const k = shown && shown.width ? shown.width / shot.width : 1;
  const marks = (comment?.marks ?? []).flatMap((m) => (m.mark.box ? [{ n: m.n, style: m.mark.style, box: { x: m.mark.box.x * k, y: m.mark.box.y * k, w: m.mark.box.w * k, h: m.mark.box.h * k } }] : []));
  return (
    <div className="wb-frozen">
      <img ref={img} src={shot.image} alt="The page, as it was when comment mode started" draggable={false} onLoad={() => setTick((t) => t + 1)} />
      <Marks items={marks} />
      {comment?.on && shown && (
        <PickOverlay
          label="Click an element or drag an area of the page"
          onPick={(b, click) => {
            const r = img.current!.getBoundingClientRect();
            if (click && !contains({ x: r.left, y: r.top, w: r.width, h: r.height }, b.x, b.y)) return;
            const kk = shot.width / r.width;
            const page: Box = { x: (b.x - r.left) * kk, y: (b.y - r.top) * kk, w: b.w * kk, h: b.h * kk };
            void pickOnPage(page, click, shot, img.current!, b).then((p) => p && comment.onPick(p, 0));
          }}
        />
      )}
    </div>
  );
}

/** What is under the click or in the area of the frozen page, asked of the live page (same scroll: it was just shot). */
async function pickOnPage(page: Box, click: boolean, shot: BrowserShot, img: HTMLImageElement, rect: Box): Promise<PanePick | null> {
  const chatId = img.closest<HTMLElement>('[data-browser-chat]')?.dataset.browserChat;
  const found = chatId ? await api.browserInspect(chatId, click ? { x: page.x, y: page.y, w: 0, h: 0 } : page).catch(() => null) : null;
  const of = { w: shot.width, h: shot.height };
  if (click) {
    const el = found?.element;
    if (el)
      return {
        anchor: { type: 'element', selector: el.selector, text: el.text, tag: el.tag },
        rect: { x: rect.x, y: rect.y, w: 0, h: 0 },
        mark: { style: 'hl', box: { x: el.box.x, y: el.box.y, w: el.box.w, h: el.box.h } },
      };
    return { anchor: { type: 'spot', x: page.x, y: page.y, of, unit: 'px', under: null }, rect: { x: rect.x, y: rect.y, w: 0, h: 0 }, mark: { style: 'pin', box: { ...page, w: 0, h: 0 } } };
  }
  if (page.w < 1 || page.h < 1) return null;
  return {
    anchor: { type: 'area', box: page, of, unit: 'px', inside: found?.inside ?? [] },
    rect,
    mark: { style: 'area', box: page },
    thumb: cropThumb(img, page, shot),
  };
}

/** A small picture of the area for the chip (the shot is a data: URL, so the canvas is not tainted). */
function cropThumb(img: HTMLImageElement, b: Box, shot: BrowserShot): string | null {
  const kx = img.naturalWidth / shot.width;
  const ky = img.naturalHeight / shot.height;
  const sw = Math.max(1, b.w * kx);
  const sh = Math.max(1, b.h * ky);
  const k = Math.min(1, 96 / sw, 64 / sh) * 2;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  const g = c.getContext('2d');
  if (!g) return null;
  g.drawImage(img, b.x * kx, b.y * ky, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
