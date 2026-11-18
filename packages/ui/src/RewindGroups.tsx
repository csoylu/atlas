import type { FileChange, SideEffect } from '@atlas/shared';
import { EFFECT_KIND } from './rewindText.ts';

const changeLabel: Record<FileChange['change'], string> = { restored: 'restored', recreated: 'brought back', deleted: 'removed' };
const SHOWN_FILES = 12;

/**
 * What a rewind undoes and what it keeps (#138), in two groups: the files and side effects it takes back, then what was
 * already done and stays (with why). In the « Rewind to here? » dialog and in the chat's rewind row.
 */
export function RewindGroups({ files, effects, keptHead }: { files: FileChange[]; effects: SideEffect[]; keptHead: string }) {
  const undone = effects.filter((e) => e.outcome === 'undone');
  const kept = effects.filter((e) => e.outcome === 'kept');
  const more = files.length - SHOWN_FILES;
  return (
    <>
      {(files.length > 0 || undone.length > 0) && (
        <div className="rw-group">
          <div className="rw-head">Undone</div>
          <ul>
            {files.slice(0, SHOWN_FILES).map((f) => (
              <li key={'f' + f.path}>
                <span className="rw-what" title={f.path}>
                  <span className="rw-kind">File</span> <code>{f.path}</code>
                </span>
                <span className="rw-act">{changeLabel[f.change]}</span>
              </li>
            ))}
            {more > 0 && (
              <li>
                <span className="rw-what rw-kind">… {more} more files</span>
              </li>
            )}
            {undone.map((e, i) => (
              <Effect key={'u' + i} e={e} />
            ))}
          </ul>
        </div>
      )}
      {kept.length > 0 && (
        <div className="rw-group">
          <div className="rw-head">{keptHead}</div>
          <ul>
            {kept.map((e, i) => (
              <Effect key={'k' + i} e={e} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Effect({ e }: { e: SideEffect }) {
  return (
    <li>
      <span className="rw-what" title={e.label}>
        <span className="rw-kind">{EFFECT_KIND[e.kind]}</span> <Label e={e} />
        {e.why && <span className="rw-why">{e.why}</span>}
      </span>
      <span className="rw-act">{e.action}</span>
    </li>
  );
}

/** A task's « #131 Title » with its number set off; a push's command in mono. */
function Label({ e }: { e: SideEffect }) {
  if (e.kind === 'push') return <code>{e.label}</code>;
  const m = e.cardId ? /^(#\d+|c_[0-9a-f]+)(\s.*)?$/.exec(e.label) : null;
  if (!m) return <>{e.label}</>;
  return (
    <>
      <span className="rw-ref">{m[1]}</span>
      {m[2] ?? ''}
    </>
  );
}
