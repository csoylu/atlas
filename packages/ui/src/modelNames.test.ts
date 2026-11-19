import { describe, expect, it } from 'vitest';
import type { Model } from '@atlas/shared';
import { friendlyModel, friendlyModelOf } from './modelNames.ts';

describe('friendly model names', () => {
  it('names Claude and GPT models the way people say them', () => {
    expect(friendlyModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(friendlyModel('claude-fable-5-2')).toBe('Fable 5.2');
    expect(friendlyModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(friendlyModel('claude-haiku-4')).toBe('Haiku 4');
    expect(friendlyModel('gpt-6.2-sol')).toBe('GPT-6.2 Sol');
    expect(friendlyModel('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(friendlyModel('gpt-5')).toBe('GPT-5');
  });
  it('keeps any other name as it is', () => {
    expect(friendlyModel('qwen3.6:35b-a3b-q4_K_M')).toBe('qwen3.6:35b-a3b-q4_K_M');
    expect(friendlyModel('llama3')).toBe('llama3');
  });
  it('falls back to the id when the model is gone', () => {
    const m = { id: 'plan-claude-opus-5-5', name: 'claude-opus-5-5' } as Model;
    expect(friendlyModelOf([m], 'plan-claude-opus-5-5')).toBe('Opus 5.5');
    expect(friendlyModelOf([m], 'old-model')).toBe('old-model');
  });
});
