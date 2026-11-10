import type { Agent, Settings } from '@atlas/shared';
import { api } from './api.ts';
import { THEMES, type ThemeChoice } from './theme.ts';

export function SettingsView(props: {
  section: 'canvas' | 'board'; settings: Settings | null; agents: Agent[];
  theme: ThemeChoice; onTheme(t: ThemeChoice): void;
  onSettings(s: Settings): void; onError(e: unknown): void;
  canvasHash: string;
}) {
  return <div className="agents-view settings-view">
    {props.section === 'board' ? <section>
      <header className="section-head"><h2>Board settings</h2>
        <p>Choose who turns ideas in Triage into actionable cards.</p></header>
      {props.settings ? <label className="field settings-field">Triage agent
        <select value={props.settings.triageAgent ?? ''} onChange={(e) => {
          api.updateSettings({ triageAgent: e.target.value || null }).then(props.onSettings, props.onError);
        }}>
          <option value="">Nobody</option>
          {props.agents.map((a) => <option key={a.id} value={a.id}>@{a.id}</option>)}
        </select>
      </label> : <p className="hint">Waiting for engine settings…</p>}
      <p className="hint">Nobody leaves triage cards for you to organize manually.</p>
    </section> : <>
      <section>
        <header className="section-head"><h2>Canvas settings</h2>
          <p>Manage canvases, nodes and drawings on the canvas itself. Changes are saved automatically.</p></header>
        <a href={props.canvasHash}>Open canvases →</a>
      </section>
      <section>
        <header className="section-head"><h2>Appearance</h2>
          <p>Theme for this device, across Atlas. Drawings follow the selected theme; Auto follows your system.</p></header>
        <label className="field settings-field">Theme
          <select value={props.theme} onChange={(e) => props.onTheme(e.target.value as ThemeChoice)}>
            {THEMES.map((t) => <option key={t} value={t}>{t === 'system' ? 'Auto' : t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
          </select>
        </label>
      </section>
    </>}
  </div>;
}
