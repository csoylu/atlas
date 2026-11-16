import { useEffect, useRef, useState } from 'react';
import type { Card } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { FADE_MS, dismissKey, fades, nextPins, pinLabel, type Pin } from './chatPins.ts';
import { StatusIcon } from './StatusIcon.tsx';

/**
 * The cards this chat created, pinned at its top-left with their live state (mockup `mockups/workflow.html`).
 * Click opens the ticket modal; finished pins fade out after FADE_MS (hover pauses), any non-running pin can be unpinned.
 */
export function ChatPins(props: { chatId: string; cards: Card[]; stream: MessageStream; onOpen(id: string): void; onError(e: unknown): void }) {
  const { chatId, cards } = props;
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [pins, setPins] = useState<Pin[]>(() => nextPins([], cards, chatId, Date.now(), dismissed));
  useEffect(() => {
    setPins((prev) => nextPins(prev, cards, chatId, Date.now(), dismissed));
  }, [cards, chatId, dismissed]);
  const [now, setNow] = useState(Date.now());
  const anyRunning = pins.some((p) => p.kind === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const unpin = (p: Pin) => {
    setDismissed((d) => new Set(d).add(dismissKey(p)));
    setPins((ps) => ps.filter((x) => x.id !== p.id));
  };
  if (!pins.length) return null;
  return (
    <div className="chat-pins" role="list" aria-label="Cards from this chat">
      {pins.map((p) => (
        <PinView key={p.id} pin={p} now={now} stream={props.stream} onOpen={props.onOpen} onUnpin={() => unpin(p)} onError={props.onError} />
      ))}
    </div>
  );
}

function PinView(props: { pin: Pin; now: number; stream: MessageStream; onOpen(id: string): void; onUnpin(): void; onError(e: unknown): void }) {
  const { pin, stream, onUnpin, onError } = props;
  const running = pin.kind === 'running';
  // The run's real start, for the clock (the card's updatedAt is only a first guess).
  const [runStart, setRunStart] = useState<number | null>(null);
  useEffect(() => {
    if (!running) return setRunStart(null);
    let live = false;
    const off = stream.listen(pin.id, (e) => {
      if (e.type !== 'run') return;
      live = true;
      setRunStart(e.run.status === 'running' ? Date.parse(e.run.startedAt) : null);
    });
    api.runs(pin.id).then((rs) => {
      const r = rs[0];
      if (!live && r?.status === 'running') setRunStart(Date.parse(r.startedAt));
    }, onError);
    return off;
  }, [pin.id, running, stream, onError]);

  // Fade: a timer from finishedAt, paused while hovered or focused.
  const [fading, setFading] = useState(false);
  const left = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armedAt = useRef(0);
  const paused = useRef(false);
  const fadeOut = useRef(onUnpin);
  fadeOut.current = onUnpin;
  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    armedAt.current = Date.now();
    timer.current = setTimeout(() => {
      setFading(true);
      timer.current = setTimeout(() => fadeOut.current(), 1200);
    }, Math.max(0, left.current));
  };
  useEffect(() => {
    setFading(false);
    if (!fades(pin.kind) || pin.finishedAt === null) return;
    left.current = FADE_MS - (Date.now() - pin.finishedAt);
    if (!paused.current) arm();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [pin.kind, pin.finishedAt]);
  const pause = () => {
    paused.current = true;
    if (!timer.current || !fades(pin.kind)) return;
    clearTimeout(timer.current);
    timer.current = null;
    setFading(false);
    left.current = Math.max(left.current - (Date.now() - armedAt.current), 1500);
  };
  const resume = () => {
    paused.current = false;
    if (fades(pin.kind) && pin.finishedAt !== null && !timer.current) arm();
  };

  const label = pinLabel({ kind: pin.kind, since: runStart ?? pin.since }, props.now);
  return (
    <div
      role="listitem"
      className={`chat-pin ${pin.kind}${fading ? ' fading' : ''}`}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <button type="button" className="chat-pin-open" onClick={() => props.onOpen(pin.id)} title={`${pin.title} · ${label}`}>
        <StatusIcon status={pin.kind === 'waiting' ? 'todo' : pin.kind === 'stopped' ? 'failed' : pin.kind === 'deleted' ? 'closed' : pin.kind} />
        <span className="chat-pin-title">{pin.title}</span>
        <span className="chat-pin-state">{label}</span>
      </button>
      {!running && (
        <button type="button" className="chat-pin-x" onClick={onUnpin} aria-label={`Unpin “${pin.title}”`} title="Unpin">
          ×
        </button>
      )}
    </div>
  );
}
