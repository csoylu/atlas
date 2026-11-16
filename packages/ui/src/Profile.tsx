import { useState } from 'react';
import { USER_ABOUT_MAX, type Settings } from '@atlas/shared';
import { api } from './api.ts';

/**
 * Who the user is: their name (how agents address them) and a sentence about themselves (agents adapt to it). Both
 * are required. Asked on first launch (Welcome) and editable in Settings → About you.
 */
function ProfileForm(props: { settings: Settings; submit: string; autoFocus?: boolean; onSaved(s: Settings): void }) {
  const [name, setName] = useState(props.settings.userName ?? '');
  const [about, setAbout] = useState(props.settings.userAbout ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ready = name.trim().length > 0 && about.trim().length > 0;
  const changed = name.trim() !== (props.settings.userName ?? '') || about.trim() !== (props.settings.userAbout ?? '');
  const save = () => {
    setSaving(true);
    setError(null);
    api
      .updateSettings({ userName: name.trim(), userAbout: about.trim() })
      .then(props.onSaved, (e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };
  return (
    <form
      className="profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && changed && !saving) save();
      }}
    >
      <label className="field">
        Your name
        <input value={name} maxLength={40} autoFocus={props.autoFocus} onChange={(e) => setName(e.target.value)} placeholder="How agents address you" />
      </label>
      <label className="field">
        <span>
          About you <span className="count">{about.length}/{USER_ABOUT_MAX}</span>
        </span>
        <textarea
          rows={3}
          value={about}
          maxLength={USER_ABOUT_MAX}
          onChange={(e) => setAbout(e.target.value)}
          placeholder="e.g. I'm an engineer, 29, working as a software developer. / I'm 12 and learning to code."
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="profile-actions">
        <button type="submit" className="primary" disabled={!ready || !changed || saving}>
          {props.submit}
        </button>
      </div>
    </form>
  );
}

/** First launch, or name / description missing: can't be dismissed until both are given. */
export function Welcome(props: { settings: Settings; onSaved(s: Settings): void }) {
  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <h2 id="welcome-title">Welcome to Atlas</h2>
        <p>Your agents work for you. Tell them who you are so they talk to you the right way. You can change this later in Settings → About you.</p>
        <ProfileForm settings={props.settings} submit="Continue" autoFocus onSaved={props.onSaved} />
      </div>
    </div>
  );
}

/** Settings → About you. */
export function ProfileSettings(props: { settings: Settings | null; onSettings(s: Settings): void }) {
  return (
    <section>
      <header className="section-head">
        <h2>About you</h2>
        <p>Every agent sees this in its instructions: it addresses you by name and adapts to who you are. Agents can't change it.</p>
      </header>
      {props.settings ? (
        <ProfileForm key={`${props.settings.userName}|${props.settings.userAbout}`} settings={props.settings} submit="Save" onSaved={props.onSettings} />
      ) : (
        <p className="hint">Waiting for engine settings…</p>
      )}
    </section>
  );
}

/** The user's display name: the name they gave, or "You". */
export const userLabel = (s: Settings | null) => s?.userName ?? 'You';
