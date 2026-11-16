import { useCallback, useEffect, useRef, useState } from 'react';
import { INPUT_MONITORING_SETTINGS, PTT_HOLD_OPTION, VOICE_NAMES, pttAction, pttShortcutLabel, pttShortcutProblem, type VoiceName, type VoiceStatus } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';

const voiceLabel = (v: VoiceName) => `Voice ${v.slice('voice-'.length)}`;
/** macOS: System Settings → Privacy & Security → Microphone (opens in the system, not in Atlas). */
const MIC_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const gb = (b: number) => (b / 1e9).toFixed(2) + ' GB';

/** KeyboardEvent.code → the key of an Electron accelerator (code, not key: ⌥ changes e.key on a Mac). */
const CODE_KEYS: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
};
/** A key press → an accelerator (« Alt+Space »), or null for a lone modifier (still being pressed). */
export function acceleratorOf(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.code) ? e.code : CODE_KEYS[e.code];
  if (!key) return null;
  return [e.metaKey && 'Command', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

/**
 * Push-to-talk shortcut: shown as keys, « Change » records the next key press (Esc cancels); ⌥ pressed and released
 * alone picks « hold ⌥ » (card #75).
 */
function ShortcutField(props: { value: string; disabled: boolean; onChange(acc: string): void }) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    let altAlone = false;
    const done = (acc: string) => {
      setProblem(null);
      setRecording(false);
      props.onChange(acc);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      altAlone = (e.code === 'AltLeft' || e.code === 'AltRight') && !e.metaKey && !e.ctrlKey && !e.shiftKey;
      if (e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(false);
        setProblem(null);
        return;
      }
      const acc = acceleratorOf(e);
      if (!acc) return; // a modifier alone: wait for the key (or ⌥'s release)
      const p = pttShortcutProblem(acc);
      if (p) return setProblem(`${pttShortcutLabel(acc)}: ${p}`);
      done(acc);
    };
    const onUp = (e: KeyboardEvent) => {
      if ((e.code === 'AltLeft' || e.code === 'AltRight') && altAlone) done(PTT_HOLD_OPTION);
      altAlone = false;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [recording, props]);
  const hold = props.value === PTT_HOLD_OPTION;
  return (
    <div className="ptt-field">
      <div className="ptt-keys">
        <span className="ptt-shortcut" aria-label={`Shortcut ${pttShortcutLabel(props.value)}`}>
          {hold ? (
            <>
              <kbd>⌥ Option</kbd>
              <span className="ptt-hold">hold</span>
            </>
          ) : (
            pttShortcutLabel(props.value)
              .split(/(?<=[⌃⌥⇧⌘])|\s+/)
              .map((k) => k.trim())
              .filter(Boolean)
              .map((k, i) => <kbd key={i}>{k}</kbd>)
          )}
        </span>
        <button className={'ghost small ptt-change' + (recording ? ' rec' : '')} disabled={props.disabled} onClick={() => (setRecording(!recording), setProblem(null))}>
          {recording ? 'Press a shortcut, or ⌥ alone to hold… (Esc cancels)' : 'Change'}
        </button>
      </div>
      {problem && (
        <div className="model-error" role="alert">
          {problem}
        </div>
      )}
    </div>
  );
}

/**
 * Settings → Voice (desktop app only, engine/src/voice.ts): « Hi Atlas » voice mode, all on this Mac. Turning it on
 * downloads the models (~840 MB, resumable) and asks macOS for the microphone. Failures are shown on the page.
 */
export function VoiceSettings(props: { stream: MessageStream; onError(e: unknown): void }) {
  const { stream, onError } = props;
  const [s, setS] = useState<VoiceStatus | null>(null);
  const [sensitivity, setSensitivity] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    api.voice().then(setS, onError);
    return stream.listen('voice', (e) => {
      if (e.type === 'voice') setS(e.status);
    });
  }, [stream, onError]);
  useEffect(() => () => audio.current?.pause(), []);

  const update = useCallback((patch: Parameters<typeof api.updateVoice>[0]) => api.updateVoice(patch).then(setS, onError), [onError]);
  // The slider saves when it stops moving.
  useEffect(() => {
    if (sensitivity === null || sensitivity === s?.sensitivity) return;
    const t = setTimeout(() => void update({ sensitivity }), 300);
    return () => clearTimeout(t);
  }, [sensitivity, s?.sensitivity, update]);

  const test = async () => {
    if (!s) return;
    setTesting(true);
    setTestError(null);
    try {
      const url = URL.createObjectURL(await api.testVoice(s.voice));
      audio.current?.pause();
      const a = (audio.current = new Audio(url));
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  if (!s) return <div className="model-row skeleton" />;
  const total = s.models.reduce((n, m) => n + m.bytes, 0);
  const missing = s.models.filter((m) => !m.installed);
  const ttsInstalled = s.models.find((m) => m.id === 'tts')?.installed ?? false;
  const pct = s.download ? Math.min(100, (s.download.received / s.download.total) * 100) : 0;
  const triggers = [s.wakeWord && 'say « Hi Atlas »', s.ptt.enabled && pttAction(s.ptt.shortcut)].filter(Boolean).join(' or ');
  const state = !s.enabled
    ? 'Off'
    : s.download
      ? 'Downloading the models…'
      : s.error
        ? 'Needs attention'
        : missing.length
          ? 'Models missing'
          : s.mic !== 'granted'
            ? 'Needs the microphone'
            : s.paused
              ? 'Listening paused'
              : triggers
                ? `Ready: ${triggers}`
                : 'Ready: no way to start (see below)';
  const level = sensitivity ?? s.sensitivity;

  return (
    <section className="voice-settings">
      <header className="section-head">
        <h2>Voice</h2>
        <p>Say « Hi Atlas » and talk to Atlas. Wake word, speech to text and the voice all run on this Mac: audio never leaves it, only the text of what you say goes to the agent.</p>
      </header>
      <div className="model-list">
        <div className={'model-row' + (s.enabled && (s.error || (s.mic !== 'granted' && s.mic !== 'not-determined')) ? ' bad' : s.ready ? ' ok' : '')}>
          <div className="model-main">
            <div className="model-title">
              <span className="model-name">Voice mode</span>
              <span className={'badge' + (s.ready ? ' ok' : s.enabled && s.error ? ' bad' : '')}>{state}</span>
            </div>
            <p className="plan-text">
              Turning it on downloads the voice models once ({gb(total)}) and asks macOS for the microphone.
            </p>
            {s.download && (
              <div>
                <div className="progress" role="progressbar" aria-label="Model download" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: pct + '%' }} />
                </div>
                <div className="model-detail">
                  <span>{s.download.model}</span>
                  <span className="num">
                    {gb(s.download.received)} of {gb(s.download.total)} · {Math.round(pct)}%
                  </span>
                </div>
              </div>
            )}
            {s.error && (
              <div className="model-error voice-error" role="alert">
                <span>{s.error}</span>
                <button className="ghost small" onClick={() => api.retryVoiceDownload().then(setS, onError)}>
                  Retry
                </button>
              </div>
            )}
            {s.paused && (
              <div className="voice-paused" role="status">
                <span>
                  Listening is paused{s.paused.until ? ` until ${new Date(s.paused.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}: the microphone is
                  closed (menu bar orb → Pause listening).
                </span>
                <button className="ghost small" onClick={() => void update({ pause: null })}>
                  Resume
                </button>
              </div>
            )}
            {s.enabled && (s.mic === 'denied' || s.mic === 'restricted') && (
              <div className="model-error voice-error" role="alert">
                <span>
                  Atlas may not use the microphone{s.mic === 'restricted' ? ' (restricted on this Mac)' : ''}. Allow it in System Settings → Privacy &amp; Security →
                  Microphone, then restart Atlas.
                </span>
                <a className="ghost small" href={MIC_SETTINGS} target="_blank" rel="noreferrer">
                  Open System Settings
                </a>
              </div>
            )}
          </div>
          <div className="model-actions">
            <label className="switch" title={s.enabled ? 'On' : 'Off'}>
              <input type="checkbox" aria-label="Voice mode" checked={s.enabled} onChange={(e) => void update({ enabled: e.target.checked })} />
              <span />
            </label>
          </div>
        </div>

        <div className="model-row voice-models">
          <div className="model-main">
            {s.models.map((m) => (
              <div key={m.id} className="model-detail voice-model">
                <span className="voice-model-name">{m.label}</span>
                <span className="num">{gb(m.bytes)}</span>
                <span className={'badge' + (m.installed ? ' ok' : '')}>{m.installed ? 'Downloaded' : 'Not downloaded'}</span>
              </div>
            ))}
            <div className="model-detail voice-model">
              <span className="voice-model-name">Microphone</span>
              <span className={'badge' + (s.mic === 'granted' ? ' ok' : s.mic === 'denied' || s.mic === 'restricted' ? ' bad' : '')}>
                {s.mic === 'granted' ? 'Allowed' : s.mic === 'denied' ? 'Denied' : s.mic === 'restricted' ? 'Restricted' : 'Not asked yet'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <h3 className="voice-sub">How you start talking</h3>
      <div className="model-list">
        <div className="model-row">
          <div className="model-main">
            <div className="model-title">
              <span className="model-name">Wake word « Hey Atlas »</span>
            </div>
            <p className="plan-text">
              Listens all the time and transcribes what is said near the Mac to catch « Hey Atlas »: uses CPU in loud places or with a video playing. Off: the microphone stays closed
              until you press the shortcut.
            </p>
          </div>
          <div className="model-actions">
            <label className="switch" title={s.wakeWord ? 'On' : 'Off'}>
              <input type="checkbox" aria-label="Wake word" checked={s.wakeWord} onChange={(e) => void update({ wakeWord: e.target.checked })} />
              <span />
            </label>
          </div>
        </div>
        <div className={'model-row' + (s.ptt.enabled && s.ptt.error ? ' bad' : '')}>
          <div className="model-main">
            <div className="model-title">
              <span className="model-name">Push-to-talk shortcut</span>
            </div>
            <p className="plan-text">
              {s.ptt.shortcut === PTT_HOLD_OPTION
                ? 'Works in any app, like a walkie-talkie: hold ⌥ Option alone and talk, release it to send. It interrupts Atlas while it speaks. ⌥ with another key or a click, or a quick tap, does nothing. Default; needs the Input Monitoring permission.'
                : 'Works in any app. Press it: the orb wakes, « Yes? », then talk. Again while Atlas speaks: interrupts it. Again while it listens: ends the conversation (like Esc).'}
            </p>
            <ShortcutField value={s.ptt.shortcut} disabled={!s.ptt.enabled} onChange={(acc) => void update({ pttShortcut: acc })} />
            {s.ptt.enabled && s.ptt.error && (
              <div className="model-error voice-error" role="alert">
                <span>{s.ptt.error}</span>
                {s.ptt.permission && (
                  <a className="ghost small" href={INPUT_MONITORING_SETTINGS} target="_blank" rel="noreferrer">
                    Open System Settings
                  </a>
                )}
              </div>
            )}
          </div>
          <div className="model-actions">
            <label className="switch" title={s.ptt.enabled ? 'On' : 'Off'}>
              <input type="checkbox" aria-label="Push-to-talk shortcut" checked={s.ptt.enabled} onChange={(e) => void update({ ptt: e.target.checked })} />
              <span />
            </label>
          </div>
        </div>
      </div>
      {!s.wakeWord && !s.ptt.enabled && (
        <div className="voice-paused voice-none" role="status">
          Wake word and shortcut are both off: voice mode has no way to start. Turn one on, or use « Start talking » in the menu bar.
        </div>
      )}

      <div className="voice-fields">
        <label className="field settings-field">
          Voice
          <div className="voice-pick">
            <select value={s.voice} onChange={(e) => void update({ voice: e.target.value as VoiceName })}>
              {VOICE_NAMES.map((v, i) => (
                <option key={v} value={v}>
                  {voiceLabel(v)}{i === 0 ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <button className="ghost" disabled={!ttsInstalled || testing} title={ttsInstalled ? undefined : 'Turn voice on to download the voice first'} onClick={() => void test()}>
              {testing ? 'Speaking…' : 'Test voice'}
            </button>
          </div>
        </label>
        {testError && (
          <div className="model-error" role="alert">
            Test voice failed: {testError}
          </div>
        )}
        <label className={'field settings-field' + (s.wakeWord ? '' : ' dim')} title={s.wakeWord ? undefined : 'The wake word is off'}>
          Wake word sensitivity
          <input type="range" disabled={!s.wakeWord} min={0} max={1} step={0.05} value={level} aria-valuetext={level < 1 / 3 ? 'Low' : level < 2 / 3 ? 'Medium' : 'High'} onChange={(e) => setSensitivity(Number(e.target.value))} />
          <div className="voice-scale">
            <span>Low: fewer false wakes</span>
            <span>High: hears you from farther</span>
          </div>
        </label>
        <p className="hint">Low accepts only « Hi / Hey / Hello Atlas » said clearly; higher picks up quieter speech and near misses like « Hi at last ».</p>
      </div>
    </section>
  );
}
