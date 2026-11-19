import { useEffect, useState } from 'react';
import type { FieldTest, TriggerConfig, WebhookInfo, Workflow } from '@atlas/shared';
import { api } from './api.ts';
import { useProjects } from './projects.tsx';
import { relative } from './workflowView.ts';

type WebhookTrigger = Extract<TriggerConfig, { kind: 'webhook' }>;
type SetConfig = (c: WebhookTrigger, key?: string | null) => void;

/** The tests a webhook filter offers (the full set is in FieldTest; these are the useful ones on a payload). */
const OPS: { op: FieldTest['op']; label: string }[] = [
  { op: 'is', label: 'is' },
  { op: 'isNot', label: 'is not' },
  { op: 'contains', label: 'contains' },
  { op: 'isNotEmpty', label: 'is set' },
];
const NO_VALUE = new Set<FieldTest['op']>(['isEmpty', 'isNotEmpty']);

/** « wh_7Qk2…9fA »: the token shortened on screen (Copy gives the whole URL). */
export function shortUrl(url: string): string {
  return url.replace(/(\/hook\/wh_[\w-]{4})[\w-]+([\w-]{3})$/, '$1…$2');
}

/**
 * A webhook trigger (#260): its secret URL (desktop: reachable from this Mac only, with the port-change error), its
 * « Only if » tests on payload fields, the loop guard and the last call.
 */
export function WebhookFields({ t, w, set }: { t: WebhookTrigger; w: Workflow; set: SetConfig }) {
  const { byId } = useProjects();
  const [info, setInfo] = useState<WebhookInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Rows being edited, an empty field included (a new filter); the trigger keeps only the filled ones.
  const [rows, setRows] = useState<FieldTest[]>(t.filters);
  useEffect(() => {
    setRows((r) => {
      const filled = r.filter(complete);
      return JSON.stringify(filled) === JSON.stringify(t.filters) ? r : t.filters;
    });
  }, [t.filters]);
  // Reloaded with the workflow (a call or a save updates it): the hook exists once the trigger is saved.
  useEffect(() => {
    let live = true;
    api.webhook(w.id).then(
      (i) => live && (setInfo(i), setError(null)),
      (e: Error) => live && setError(/no webhook trigger/.test(e.message) ? null : e.message),
    );
    return () => {
      live = false;
    };
  }, [w]);
  const put = (next: FieldTest[], key: string | null = null) => {
    setRows(next);
    set({ ...t, filters: next.filter(complete) }, key);
  };
  const base = info ? (info.server ? window.location.origin : info.localUrl) : null;
  const url = info?.path && base ? base + info.path : null;
  const copy = () => {
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        if (info?.movedFrom) api.webhookSeen(w.id).then(() => setInfo({ ...info, movedFrom: null }), (e: Error) => setError(e.message));
      },
      (e: Error) => setError(`couldn't copy: ${e.message}`),
    );
  };
  const regenerate = () => {
    setConfirm(false);
    api.regenerateWebhook(w.id).then((i) => setInfo(i), (e: Error) => setError(e.message));
  };
  const project = w.projectId ? (byId(w.projectId)?.name ?? w.projectId) : null;
  const last = info?.lastCall ?? null;
  return (
    <>
      <div className="field">
        {info && !info.server ? 'URL · reachable from this Mac only' : 'URL'}
        {url ? (
          <div className="wf-hookurl">
            <span className="mono" title="Copy gives the whole URL">
              {shortUrl(url)}
            </span>
            <button type="button" className="ghost small" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <div className="wf-hookurl">
            <span className="muted">{info ? 'The secret store is locked: unlock it in Settings → Secrets to see the URL.' : error ? '' : 'The URL appears once the trigger is saved…'}</span>
          </div>
        )}
        {info && (
          <span className="help">
            {info.server
              ? 'Send a POST with a JSON body. Anyone with the URL can start the workflow: keep it secret.'
              : 'The desktop app listens on this Mac only and its port changes at each launch (this field always shows the current one). A local script or git hook can call it; GitHub, Vercel or any outside service needs Atlas in server mode. Anyone with the URL can start the workflow: keep it secret.'}
          </span>
        )}
        {info && (
          <span className="wf-hookacts">
            {confirm ? (
              <>
                <span className="help">The old URL stops working at once.</span>
                <button type="button" className="ghost small danger" onClick={regenerate}>
                  Make a new URL
                </button>
                <button type="button" className="ghost small" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="ghost small" onClick={() => setConfirm(true)}>
                New URL…
              </button>
            )}
          </span>
        )}
      </div>
      {info?.movedFrom && (
        <div className="wf-hookerr" role="alert">
          <b>Unreachable since the last launch.</b> The port changed ({info.movedFrom} → {info.port}): a caller still using the old URL gets no answer, and Atlas can't see those calls. Copy the new URL into your script.
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="field">
        Only if
        <div className="wf-filters">
          {project && (
            <div className="wf-flt">
              <span className="fx">Project</span>
              <span className="muted">is</span>
              <span className="fx">{project}</span>
              <span className="muted lock" title="Its steps work in this project">
                fixed
              </span>
            </div>
          )}
          {rows.map((r, i) => (
            <div key={i} className="wf-flt wf-pflt">
              <input aria-label="Payload field" className="mono" value={r.field} placeholder="payload.ref" onChange={(e) => put(rows.map((x, j) => (j === i ? { ...x, field: e.target.value.trim() } : x)), `pfield${i}`)} />
              <select aria-label="Test" value={r.op} onChange={(e) => put(rows.map((x, j) => (j === i ? { ...x, op: e.target.value as FieldTest['op'] } : x)))}>
                {OPS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
              {NO_VALUE.has(r.op) ? <span /> : <input aria-label="Value" value={r.value} placeholder="refs/heads/main" onChange={(e) => put(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)), `pvalue${i}`)} />}
              <button type="button" className="sd-btn" aria-label="Remove filter" onClick={() => put(rows.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="ghost small wf-addflt" onClick={() => setRows([...rows, { field: 'payload.', op: 'is', value: '' }])}>
            + Add a filter
          </button>
        </div>
        <span className="help">Exact tests on the body's fields (payload.ref, payload.repository.full_name…), no model. A call that fails one is skipped.</span>
      </div>
      <label className="field">
        Loop guard
        <span className="wf-guardfld">
          At most
          <input
            type="number"
            min={1}
            max={100}
            aria-label="Runs per hour at most"
            value={t.maxRunsPerHour}
            onChange={(e) => set({ ...t, maxRunsPerHour: Math.min(100, Math.max(1, Math.round(+e.target.value) || 1)) }, 'guard')}
          />
          runs started by calls per hour
        </span>
      </label>
      <div className="field">
        {last ? `Last call · ${relative(last.at)} · ${last.result === 'ran' ? 'ran' : last.result === 'skipped' ? 'skipped' : 'refused'}` : 'Last call'}
        {last?.body && <pre className="wf-hookbody">{pretty(last.body)}</pre>}
        <span className="help wf-hookhelp">
          {!last
            ? 'No call yet.'
            : last.result === 'ran'
              ? `${cap(last.reason)}. Its fields appear in « Insert a field » under Payload.`
              : last.result === 'skipped'
                ? `Skipped: ${last.reason}. Its fields appear in « Insert a field » under Payload.`
                : `Refused: ${last.reason}.`}
        </span>
      </div>
    </>
  );
}

const complete = (r: FieldTest) => /^payload(\.[^.\s]+)+$/.test(r.field) && (NO_VALUE.has(r.op) || r.value !== '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
