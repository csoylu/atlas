import type { Agent, VoiceStatus } from '@atlas/shared';

/** The chat voice turns land in (engine voiceChat.ts): atlas's main chat if atlas is enabled, else the first enabled agent's. */
export function voiceChatId(agents: Pick<Agent, 'id' | 'enabled' | 'mainChat'>[]): string | null {
  const enabled = agents.filter((a) => a.enabled);
  return (enabled.find((a) => a.id === 'atlas') ?? enabled[0])?.mainChat ?? null;
}

/**
 * What the composer's mic does on click: turn voice mode on or off, or open Settings → Voice when voice is on but
 * cannot listen (a model missing or downloading, no microphone access, a load error): never a button that silently
 * does nothing. A paused voice mode is still on: the click turns it off, the menu bar resumes it.
 */
export function voiceToggle(s: VoiceStatus): { kind: 'on' | 'off' | 'settings'; label: string } {
  if (!s.enabled) return { kind: 'on', label: 'Voice mode: off. Click to turn it on' };
  const broken = !!s.error || s.mic === 'denied' || s.mic === 'restricted' || s.models.some((m) => !m.installed);
  if (broken) return { kind: 'settings', label: `Voice mode can't listen yet${s.error ? ': ' + s.error : ''}. Open Settings → Voice` };
  return { kind: 'off', label: s.paused ? 'Voice mode: on, listening paused. Click to turn it off' : 'Voice mode: on. Click to turn it off' };
}
