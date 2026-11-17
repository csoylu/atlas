import { describe, expect, it } from 'vitest';
import type { ChatGptStatus, ClaudePlanStatus, LocalModel, LocalStatus, Model } from '@atlas/shared';
import { chatgptSource, claudeSource, localSource, modelId, planModelId } from './availableModels.ts';

// Only the fields the helpers read; the casts keep the fixtures short.
const claude = (p: Partial<ClaudePlanStatus>) => ({ available: true, unavailableReason: null, signedIn: true, configured: true, ...p }) as ClaudePlanStatus;
const gpt = (p: Partial<ChatGptStatus>) => ({ available: true, unavailableReason: null, signedIn: true, planUsage: true, ...p }) as ChatGptStatus;
const local = (p: Partial<LocalStatus>) => ({ binary: '/opt/homebrew/bin/ollama', running: true, ...p }) as LocalStatus;
const model = (provider: Model['provider'], name: string) => ({ id: 'x', provider, name }) as Model;
const lm = (name: string, usedBy: string[] = []) => ({ name, parameterSize: '8B', quantization: 'Q4_K_M', usedBy }) as unknown as LocalModel;

describe('Model list « Available to add » (#101)', () => {
  it('lists Claude plan models with the same ids and Added state as the old Subscriptions list', () => {
    const src = claudeSource(claude({}), [{ id: 'claude-opus-5', displayName: 'Claude Opus 5' }, { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' }] as never, [model('claude_plan', 'claude-opus-5')]);
    expect(src.state.kind).toBe('list');
    if (src.state.kind !== 'list') return;
    expect(src.state.rows.map((r) => r.added)).toEqual([true, false]);
    expect(src.state.rows[1]?.add).toEqual({ kind: 'create', model: { id: 'plan-claude-sonnet-5', provider: 'claude_plan', name: 'claude-sonnet-5' } });
  });
  it('shows one muted line linking to Subscriptions when a plan is signed out or not allowed', () => {
    expect(claudeSource(claude({ signedIn: false }), null, []).state).toMatchObject({ kind: 'off', href: '#/settings/subscriptions' });
    expect(chatgptSource(gpt({ signedIn: false }), null, []).state).toMatchObject({ kind: 'off', href: '#/settings/subscriptions' });
    expect(chatgptSource(gpt({ planUsage: false }), null, []).state).toMatchObject({ kind: 'off', href: '#/settings/subscriptions' });
    expect(claudeSource(claude({ available: false, unavailableReason: 'Not here' }), null, []).state).toMatchObject({ kind: 'off', text: 'Not here' });
  });
  it('lists ChatGPT plan models by slug', () => {
    const src = chatgptSource(gpt({}), [{ slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }] as never, [model('claude_plan', 'gpt-6.1-sol')]);
    if (src.state.kind !== 'list') throw new Error(src.state.kind);
    expect(src.state.rows[0]).toMatchObject({ added: false, add: { kind: 'create', model: { id: 'gpt-6-1-sol', provider: 'chatgpt', name: 'gpt-6.1-sol' } } });
  });
  it('lists local models through the engine helper, Added once an Atlas model uses them', () => {
    const src = localSource(local({}), [lm('qwen3:8b', ['qwen3-8b']), lm('llama4:8b')]);
    if (src.state.kind !== 'list') throw new Error(src.state.kind);
    expect(src.state.rows.map((r) => [r.added, r.add])).toEqual([
      [true, { kind: 'local', name: 'qwen3:8b' }],
      [false, { kind: 'local', name: 'llama4:8b' }],
    ]);
    expect(src.state.rows[0]?.code).toBe('8B · Q4_K_M');
  });
  it('points to the Local page when Ollama is missing, stopped or has no models', () => {
    for (const s of [localSource(local({ binary: null, running: false }), null), localSource(local({ running: false }), null), localSource(local({}), [])])
      expect(s.state).toMatchObject({ kind: 'off', href: '#/settings/local' });
  });
  it('waits for the status before saying anything', () => {
    expect(claudeSource(null, null, []).state.kind).toBe('loading');
    expect(chatgptSource(gpt({}), null, []).state.kind).toBe('loading');
    expect(localSource(local({}), null).state.kind).toBe('loading');
  });
  it('keeps the model ids unchanged', () => {
    expect(planModelId('claude-opus-5')).toBe('plan-claude-opus-5');
    expect(modelId('gpt-6.1-sol')).toBe('gpt-6-1-sol');
    expect(modelId('5x')).toBe('m-5x');
  });
});
