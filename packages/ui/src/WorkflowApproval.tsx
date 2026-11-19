import { useState } from 'react';
import type { Workflow, WorkflowCommandStep } from '@atlas/shared';
import { api } from './api.ts';
import { runVarsOf } from './workflowView.ts';

/**
 * « Waiting for your approval » (#262, mockup « Webhook »): above the canvas (above the steps on a phone) while a
 * « Run a command » step is not approved. It shows exactly what Approve allows: command, checkout, secrets, the payload's
 * environment variables, the time limit. Approve sends the revision shown (a stale one is refused by the engine).
 */
export function ApprovalBanner({ w, onError }: { w: Workflow; onError(e: unknown): void }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const waiting = w.commandSteps.filter((s) => !s.approved);
  if (!waiting.length) return null;
  const who = w.createdBy === 'user' ? 'An agent changed this workflow' : `@${w.createdBy} made this workflow`;
  const names = waiting.map((s) => `« ${s.title} »`).join(', ');
  const act = (k: 'approve' | 'reject') => {
    if (k === 'reject' && !confirm(`Reject the command${waiting.length > 1 ? 's' : ''} of « ${w.name} »? The workflow is turned off until a command is edited and approved.`)) return;
    setBusy(k);
    (k === 'approve' ? api.approveWorkflow(w.id, w.revision) : api.rejectWorkflow(w.id)).catch(onError).finally(() => setBusy(null));
  };
  return (
    <div className="wf-appr" role="alert">
      <div className="wf-appr-h">
        <span className="ico" aria-hidden="true">
          !
        </span>
        <b>Waiting for your approval</b>
      </div>
      <p>
        {who} and {names} {waiting.length > 1 ? 'run commands' : 'runs a command'}, so it can't start until you approve exactly this:
      </p>
      {waiting.map((s) => (
        <CommandFacts key={s.nodeId} s={s} webhook={w.nodes.some((n) => n.kind === 'trigger' && n.config.kind === 'webhook')} title={waiting.length > 1} />
      ))}
      <p>An agent's later edit of any of these asks again; your own edits don't.</p>
      <div className="wf-appr-acts">
        <button className="head-btn" disabled={!!busy} onClick={() => act('reject')}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject…'}
        </button>
        <button className="primary small" disabled={!!busy} onClick={() => act('approve')}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}

function CommandFacts({ s, webhook, title }: { s: WorkflowCommandStep; webhook: boolean; title: boolean }) {
  const vars = runVarsOf(s.command).filter((x) => x.startsWith('PAYLOAD_'));
  return (
    <dl className="wf-appr-kv">
      {title && (
        <>
          <dt>Step</dt>
          <dd>{s.title}</dd>
        </>
      )}
      <dt>Command</dt>
      <dd>
        <pre className="mono">{s.command}</pre>
      </dd>
      <dt>Checkout</dt>
      <dd>{s.checkout.repo ? `${s.checkout.repo} · ${s.checkout.ref} · a clean checkout owned by the project, not an agent's clone` : "the project has no repo: the step can't run"}</dd>
      <dt>Secrets</dt>
      <dd>
        {s.secrets.length ? (
          <>
            {s.secrets.map((x, i) => (
              <span key={x}>
                {i > 0 && ', '}
                <span className="mono">{x}</span>
              </span>
            ))}{' '}
            · granted to this step only
          </>
        ) : (
          'none'
        )}
      </dd>
      {(webhook || vars.length > 0) && (
        <>
          <dt>From the payload</dt>
          <dd>
            environment variables{' '}
            {vars.length ? (
              vars.map((x, i) => (
                <span key={x}>
                  {i > 0 && ', '}
                  <span className="mono">{x}</span>
                </span>
              ))
            ) : (
              <span className="mono">PAYLOAD_*</span>
            )}
            ; never pasted into the command line
          </dd>
        </>
      )}
      <dt>Time limit</dt>
      <dd>{s.limitMin} min</dd>
    </dl>
  );
}
