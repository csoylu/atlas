import { useEffect, useState } from 'react';
import type { Agent, VoiceStatus } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { voiceChatId, voiceToggle } from './voiceMode.ts';

/**
 * The composer's mic (redesign #271): voice mode on / off, the same state as Settings → Voice and the orb (GET / PATCH
 * /api/voice, live through `voice.updated`). Only in the desktop app (the routes answer 404 elsewhere) and only in the
 * chat voice turns land in (the voice agent's main chat, voiceChat.ts). When voice can't work yet (models missing, no
 * microphone access, a failed load) the click opens Settings → Voice, which says why and how to fix it.
 */
export function VoiceToggle(props: { chatId: string; agents: Agent[]; stream: MessageStream; onError(e: unknown): void }) {
  const { stream, onError } = props;
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const here = voiceChatId(props.agents) === props.chatId;
  useEffect(() => {
    if (!here) return;
    let gone = false;
    api.about().then((a) => {
      if (gone || !a.voice) return;
      setAvailable(true);
      api.voice().then((s) => gone || setStatus(s), onError);
    }, onError);
    const off = stream.listen('voice', (e) => {
      if (e.type === 'voice') setStatus(e.status);
    });
    return () => {
      gone = true;
      off();
    };
  }, [here, stream, onError]);
  if (!here || !available || !status) return null;
  const act = voiceToggle(status);
  return (
    <button
      type="button"
      className={'icon-btn voice-btn' + (status.enabled ? ' on' : '')}
      aria-pressed={status.enabled}
      aria-label={act.label}
      title={act.label}
      onClick={() => {
        if (act.kind === 'settings') return void (location.hash = '#/settings/voice');
        api.updateVoice({ enabled: act.kind === 'on' }).then((s) => {
          setStatus(s);
          // Turned on but it can't listen yet (models to download, microphone): Settings → Voice shows what's missing.
          if (s.enabled && voiceToggle(s).kind === 'settings') location.hash = '#/settings/voice';
        }, onError);
      }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
        <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" />
      </svg>
    </button>
  );
}
