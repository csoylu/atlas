import type { Model } from '@atlas/shared';

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * A model's friendly name (redesign #272, as Chat shows it): « Opus 5.5 » for claude-opus-5-5, « GPT-6.2 Sol » for
 * gpt-6.2-sol. Anything else (a local model, an unknown family) keeps the name the provider gives it. The id stays on
 * the agent's page for when the exact model matters.
 */
export function friendlyModel(name: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:[-.](\d+))?(?:-\d{8})?$/.exec(name);
  if (claude) return `${cap(claude[1]!)} ${claude[2]}${claude[3] ? '.' + claude[3] : ''}`;
  const gpt = /^gpt-([\d.]+[a-z]?)((?:-[a-z0-9]+)*)$/.exec(name);
  if (gpt) return ['GPT-' + gpt[1], ...gpt[2]!.split('-').filter(Boolean).map(cap)].join(' ');
  return name;
}

/** The friendly name of an agent's model by id; the bare id when the model is gone (the page says so). */
export function friendlyModelOf(models: Model[], id: string): string {
  const m = models.find((x) => x.id === id);
  return m ? friendlyModel(m.name) : id;
}
