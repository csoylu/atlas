import { describe, expect, it } from 'vitest';
import type { VoiceStatus } from '@atlas/shared';
import { voiceChatId, voiceToggle } from './voiceMode.ts';

const status = (p: Partial<VoiceStatus> = {}): VoiceStatus =>
  ({ enabled: true, error: null, mic: 'granted', models: [{ id: 'm', label: 'M', bytes: 1, installed: true }], paused: null, ready: true, ...p }) as VoiceStatus;

describe('the composer mic', () => {
  it('shows in the chat voice lands in: atlas, else the first enabled agent', () => {
    const a = (id: string, enabled = true) => ({ id, enabled, mainChat: 'c_' + id });
    expect(voiceChatId([a('munih'), a('atlas')])).toBe('c_atlas');
    expect(voiceChatId([a('atlas', false), a('paris', false), a('munih')])).toBe('c_munih');
    expect(voiceChatId([])).toBeNull();
  });
  it('turns voice mode on and off', () => {
    expect(voiceToggle(status({ enabled: false })).kind).toBe('on');
    expect(voiceToggle(status()).kind).toBe('off');
    expect(voiceToggle(status({ paused: { until: null } })).kind).toBe('off');
  });
  it('sends to Settings → Voice when voice is on but cannot listen', () => {
    expect(voiceToggle(status({ mic: 'denied' })).kind).toBe('settings');
    expect(voiceToggle(status({ models: [{ id: 'm', label: 'M', bytes: 1, installed: false }] })).kind).toBe('settings');
    expect(voiceToggle(status({ error: 'load failed' })).label).toContain('load failed');
  });
});
