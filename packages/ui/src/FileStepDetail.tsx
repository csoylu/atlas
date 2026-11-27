import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ToolCallTiming } from '@atlas/shared';
import type { Step } from './chatTurn.ts';
import { ansi, bgLog, bgOutput, diffCount, diffLines, editDiff, fileList, grepGroups, hunks, markMatches, parseNumbered, plainText, shellOutput, type DiffItem } from './fileRows.ts';
import { duration, splitPath } from './toolRows.ts';
import { HiddenNote, SecretText } from './SecretMarks.tsx';
import { hiddenNames } from './secretsView.ts';

/**
 * The expanded view of a file or shell tool (#63, mockup pages/chat-activity.html §4): a code view with line numbers,
 * a diff, grep matches grouped by file, a file list, a terminal with ANSI colours and a live tail. Every view is capped
 * at about 260 px with Show all and Copy. null = not one of them (the caller shows the generic view).
 */
export function fileDetail(step: Step, timing?: ToolCallTiming): ReactNode | null {
  if (step.kind !== 'tool' || step.result?.isError) return null;
  const o = (step.input && typeof step.input === 'object' ? step.input : {}) as Record<string, unknown>;
  const out = step.result ? step.result.content : null;
  const path = str(o.path);
  switch (step.name) {
    case 'read_file': {
      if (out === null) return null;
      const { lines, note } = parseNumbered(out);
      if (!lines.length) return <p className="state-empty inline">{out.trim() === '(empty file)' ? 'Empty file.' : out}</p>;
      return (
        <View head={<FileHead path={path} label={`lines ${lines[0]!.n}–${lines.at(-1)!.n}`} />} copy={lines.map((l) => l.text).join('\n')} note={note}>
          <Code lines={lines} />
        </View>
      );
    }
    case 'write_file': {
      const content = str(o.content);
      const w = step.detail?.kind === 'write' ? step.detail : undefined;
      if (w && !w.created && w.before !== null) {
        const d = diffLines(w.before, content);
        const { add, del } = diffCount(d);
        return (
          <View head={<FileHead path={path} label={<Delta add={add} del={del} />} />} copy={content}>
            {add + del ? <Diff items={hunks(d)} /> : <p className="state-empty inline fv-empty">Same text as before.</p>}
          </View>
        );
      }
      const lines = content.replace(/\n$/, '').split('\n');
      const label = `${w?.created ? 'new file · ' : ''}${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`;
      return (
        <View head={<FileHead path={path} label={label} />} copy={content}>
          <Code lines={lines.map((text, i) => ({ n: i + 1, text }))} />
        </View>
      );
    }
    case 'edit_file': {
      const lines = step.detail?.kind === 'edit' ? step.detail.lines : [];
      const label = lines.length > 1 ? `${lines.length} replacements · lines ${lines.join(', ')}` : lines.length ? `line ${lines[0]}` : undefined;
      const newText = str(o.new_text);
      return (
        <View head={<FileHead path={path} label={label} />} copy={newText}>
          <Diff items={editDiff(str(o.old_text), newText, lines[0])} />
        </View>
      );
    }
    case 'grep': {
      if (out === null) return null;
      const { files, note } = grepGroups(out, o.mode);
      if (!files.length) return <p className="state-empty inline">No matches.</p>;
      const pattern = str(o.pattern);
      if (o.mode === 'files') return <Files paths={files.map((f) => f.path)} note={note} />;
      return (
        <View copy={out} note={note}>
          <div className="fv-matches">
            {files.map((f, i) => (
              <div key={i} className="fv-gfile">
                <div className="fv-gpath">
                  <FvPath path={f.path} />
                  {f.lines[0]?.count !== undefined && <span className="fv-gcount">{f.lines[0].count}</span>}
                </div>
                {f.lines
                  .filter((l) => l.count === undefined)
                  .map((l, j) => (
                    <div key={j} className={'fv-gline' + (l.ctx ? ' ctx' : '')}>
                      <span className="fv-n">{l.n}</span>
                      <span className="fv-t">{l.ctx ? l.text : markMatches(l.text, pattern, o.ignore_case === true).map((p, k) => (typeof p === 'string' ? p : <mark key={k}>{p.hit}</mark>))}</span>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </View>
      );
    }
    case 'glob':
    case 'list_files': {
      if (out === null) return null;
      const { paths, note } = fileList(out);
      if (!paths.length) return <p className="state-empty inline">{step.name === 'glob' ? 'No files.' : 'Empty folder.'}</p>;
      return <Files paths={paths} note={note} />;
    }
    case 'shell': {
      const command = str(o.command);
      if (o.background === true) {
        if (out === null) return <Terminal command={command} text="" />;
        const log = bgLog(out);
        return <Terminal command={command} text={out.replace(/;.*$/s, '')} foot={log ? <span className="fv-log" title={log}>log: {log}</span> : undefined} />;
      }
      if (out === null) {
        const tail = timing?.tail ?? '';
        return <Terminal command={command} text={tail} live foot={<span>live{tail ? ` · last ${tail.split('\n').length} lines` : ''}</span>} />;
      }
      const r = shellOutput(out);
      const time = timing?.endedAt ? duration(Date.parse(timing.endedAt) - Date.parse(timing.startedAt)) : null;
      const good = r.exit === '0';
      return (
        <Terminal
          command={command}
          text={r.text}
          note={r.note}
          foot={
            r.exit && (
              <span className="fv-exit">
                <span className={'badge ' + (good ? 'ok' : 'bad')}>exit {r.exit}</span>
                {r.killed && <span>{r.killed}</span>}
                {time && <span>{time}</span>}
              </span>
            )
          }
        />
      );
    }
    case 'shell_output': {
      if (out === null) return null;
      const r = bgOutput(out);
      return <Terminal text={r.text} head={r.head} note={r.note} />;
    }
    case 'shell_kill':
      return out === null ? null : <p className="state-empty inline">{out}</p>;
  }
  return null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Box capped at ~260 px (scrolls inside), with Show all when it's cut, and Copy. */
function View({ head, children, copy, note, foot, term }: { head?: ReactNode; children: ReactNode; copy?: string; note?: ReactNode; foot?: ReactNode; term?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !all) setCut(el.scrollHeight > el.clientHeight + 1);
  });
  return (
    <div className={'fv' + (term ? ' term' : '')}>
      {head}
      <div ref={box} className={'fv-box' + (all ? ' all' : '')}>
        {children}
      </div>
      {note && <p className="fv-note">{note}</p>}
      <div className="fv-foot">
        {foot}
        <span className="fv-gap" />
        {(cut || all) && (
          <button type="button" className="fv-btn" onClick={() => setAll((a) => !a)}>
            {all ? 'Show less' : 'Show all'}
          </button>
        )}
        {copy !== undefined && copy !== '' && <CopyButton text={copy} />}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setState('done'),
      () => setState('failed'),
    );
  return (
    <button type="button" className="fv-btn" onClick={copy} onMouseLeave={() => state !== 'idle' && setTimeout(() => setState('idle'), 600)}>
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy'}
    </button>
  );
}

/** Folder faint (cut first, from its start), file name bright, the full path on hover. */
function FvPath({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className="fv-path" title={path}>
      {/* rtl so the ellipsis cuts the folder's start; the LRMs keep the slashes in place */}
      {dir && <span className="fv-dir">{`\u200e${dir}\u200e`}</span>}
      <span className="fv-name">{name}</span>
    </span>
  );
}

/** A file's header: its path; the right side: a range, a count, +/−. */
function FileHead({ path, label }: { path: string; label?: ReactNode }) {
  return (
    <div className="fv-head">
      <FvPath path={path} />
      {label && <span className="fv-label">{label}</span>}
    </div>
  );
}

function Delta({ add, del }: { add: number; del: number }) {
  return (
    <span className="chat-delta">
      {add > 0 && <span className="add">+{add}</span>}
      {del > 0 && <span className="del">−{del}</span>}
    </span>
  );
}

function Code({ lines }: { lines: { n: number; text: string }[] }) {
  return (
    <div className="fv-code">
      {lines.map((l) => (
        <div key={l.n} className="fv-dl">
          <span className="fv-n">{l.n}</span>
          <span className="fv-s" />
          <span className="fv-t">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function Diff({ items }: { items: DiffItem[] }) {
  return (
    <div className="fv-code">
      {items.map((l, i) =>
        l.t === '@' ? (
          <div key={i} className="fv-dl h">
            {l.text}
          </div>
        ) : (
          <div key={i} className={'fv-dl' + (l.t === '+' ? ' a' : l.t === '-' ? ' d' : '')}>
            <span className="fv-n">{l.t === '-' ? l.old : l.new}</span>
            <span className="fv-s">{l.t === '-' ? '−' : l.t === '+' ? '+' : ''}</span>
            <span className="fv-t">{l.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

function Files({ paths, note }: { paths: string[]; note?: string }) {
  return (
    <View copy={paths.join('\n')} note={note}>
      <div className="fv-files">
        {paths.map((p) => (
          <div key={p} className="fv-file" title={p}>
            {splitPath(p).dir && <span className="chat-row-dir">{splitPath(p).dir}</span>}
            {splitPath(p).name}
          </div>
        ))}
      </div>
    </View>
  );
}

/** A terminal: « $ command », the output with ANSI colours, then exit · duration (or « live »). */
function Terminal({ command, text, head, note, foot, live }: { command?: string; text: string; head?: string; note?: string; foot?: ReactNode; live?: boolean }) {
  const box = useRef<HTMLPreElement>(null);
  // The live tail sticks to the bottom.
  useLayoutEffect(() => {
    const scroller = box.current?.parentElement;
    if (live && scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [live, text]);
  const plain = plainText(text);
  // Values of secrets the engine replaced by [secret NAME] (#206): marked in the output, and said under it.
  const hidden = hiddenNames(text);
  const notes = (
    <>
      {note}
      {note && hidden.length > 0 && ' '}
      {hidden.length > 0 && <HiddenNote names={hidden} />}
    </>
  );
  return (
    <View term copy={plain || command} note={note || hidden.length ? notes : undefined} foot={foot}>
      <pre className="fv-term" ref={box}>
        {head && <span className="ansi-dim">{head}{'\n'}</span>}
        {command !== undefined && (
          <>
            <span className="fv-prompt">$</span> {command}
            {'\n'}
          </>
        )}
        {ansi(text.replace(/\n+$/, '')).map((s, i) => (s.cls ? <span key={i} className={s.cls}><SecretText text={s.text} /></span> : <SecretText key={i} text={s.text} />))}
        {live && <span className="fv-cursor">▍</span>}
      </pre>
    </View>
  );
}
