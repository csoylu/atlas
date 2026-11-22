import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutterLineClass, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { tags as t } from '@lezer/highlight';
import type { Lang } from './files.ts';
import type { PaneComment } from './CommentLayer.tsx';

/* ── Comments on lines (#304 on a file, #303) ─────────────────────────── */

/** A marked range of lines: a comment (its number) or the drag in progress (n = ''). */
interface LineMark {
  n: number | '';
  from: number;
  to: number;
}
const setMarks = StateEffect.define<LineMark[]>();
const marksField = StateField.define<LineMark[]>({
  create: () => [],
  update: (v, tr) => tr.effects.reduce((m, e) => (e.is(setMarks) ? e.value : m), v),
});
class MarkedLine extends GutterMarker {
  elementClass = 'wb-cl';
}
const markedLine = new MarkedLine();
/** Each marked line: a tinted line, its number in the accent, the comment's pin on its first line. */
function lineDecos(state: EditorState): { lines: DecorationSet; gutter: ReturnType<RangeSetBuilder<GutterMarker>['finish']> } {
  const doc = state.doc;
  const at = new Map<number, number | ''>();
  for (const m of state.field(marksField))
    for (let l = Math.max(1, m.from); l <= Math.min(doc.lines, m.to); l++) if (!at.has(l) || l === m.from) at.set(l, l === m.from ? m.n : (at.get(l) ?? ''));
  const lines = new RangeSetBuilder<Decoration>();
  const gutter = new RangeSetBuilder<GutterMarker>();
  for (const l of [...at.keys()].sort((a, b) => a - b)) {
    const pos = doc.line(l).from;
    const n = at.get(l);
    lines.add(pos, pos, Decoration.line({ attributes: n === '' || n === undefined ? { class: 'wb-cl' } : { class: 'wb-cl', 'data-pin': String(n) } }));
    gutter.add(pos, pos, markedLine);
  }
  return { lines: lines.finish(), gutter: gutter.finish() };
}
const commentLines: Extension = [
  marksField,
  EditorView.decorations.compute([marksField], (s) => lineDecos(s).lines),
  gutterLineClass.compute([marksField], (s) => lineDecos(s).gutter),
];


/**
 * The Files editor (#303): CodeMirror 6, loaded on its own (lazy, see FilesPane) the first time a file opens, so the
 * app's main bundle doesn't grow. Colours and type come from the app's tokens (both themes, no literal sizes).
 */
export interface CodeEditorHandle {
  text(): string;
  /** Replace the whole text (Take the agent's version), keeping undo. */
  setText(text: string): void;
  focus(): void;
}

const LANGS: Record<Lang, () => Promise<Extension>> = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
};

// The mockup's colours: keywords accent, strings green, types and numbers amber, comments faint italic.
const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier],
    color: 'var(--accent)',
  },
  {
    tag: [t.string, t.special(t.string), t.regexp, t.attributeValue],
    color: 'var(--pos-ink)',
  },
  {
    tag: [t.typeName, t.className, t.number, t.bool, t.null, t.atom, t.tagName],
    color: 'var(--warn-ink)',
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--faint)',
    fontStyle: 'italic',
  },
  { tag: [t.heading], color: 'var(--text)', fontWeight: 'var(--fw-bold)' },
  { tag: [t.link, t.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--text)' },
]);

const theme = EditorView.theme({
  '&': {
    height: '100%',
    background: 'var(--sheet)',
    color: 'var(--text)',
    fontSize: 'var(--fs-small)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    lineHeight: 'var(--lh-normal)',
    paddingBottom: '40px',
  },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
  '.cm-gutters': {
    background: 'var(--sheet)',
    color: 'var(--faint)',
    border: '0',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '32px',
    padding: '0 14px 0 0',
    borderLeft: '3px solid transparent',
  },
  '.cm-activeLine': { background: 'transparent' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--muted)' },
  '.cm-line': { padding: '0 24px 0 0' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { background: 'var(--accent-soft)' },
  '.cm-selectionMatch': { background: 'var(--hover)' },
  '.cm-matchingBracket': {
    background: 'var(--hover)',
    outline: '1px solid var(--line-2)',
  },
  '.cm-panels': {
    background: 'var(--panel)',
    color: 'var(--text)',
    borderTop: '1px solid var(--rule)',
  },
  '.cm-panels input, .cm-panels button': {
    fontFamily: 'var(--font)',
    fontSize: 'var(--fs-small)',
  },
  // The search bar (Cmd/Ctrl+F, #344): CodeMirror's base theme paints it for a light page (white fields, grey
  // gradient buttons), so every part takes the app's tokens here and follows both themes on its own.
  // Plain inline flow (not flex), so CodeMirror's <br> still puts « replace » on its own row; each part wraps whole.
  '.cm-panel.cm-search': {
    padding: '8px 40px 2px 12px',
    lineHeight: 'var(--lh-tight)',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    margin: '0 8px 6px 0',
    verticalAlign: 'middle',
  },
  '.cm-panel.cm-search .cm-textfield': {
    height: '28px',
    width: '220px',
    maxWidth: '100%',
    boxSizing: 'border-box',
    padding: '0 8px',
    background: 'var(--sheet)',
    color: 'var(--text)',
    border: '1px solid var(--control)',
    borderRadius: 'var(--radius-control)',
    fontSize: 'var(--fs-small)',
    outline: 'none',
    transition: 'border-color 0.12s, box-shadow 0.12s',
  },
  '.cm-panel.cm-search .cm-textfield::placeholder': { color: 'var(--faint)' },
  '.cm-panel.cm-search .cm-textfield:focus': {
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 3px var(--accent-soft)',
  },
  '.cm-panel.cm-search .cm-button': {
    height: '28px',
    padding: '0 10px',
    backgroundImage: 'none',
    background: 'var(--raised)',
    color: 'var(--text)',
    border: '1px solid var(--line-2)',
    borderRadius: 'var(--radius-control)',
    fontSize: 'var(--fs-small)',
    fontWeight: 'var(--fw-medium)',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search .cm-button:hover': { background: 'var(--active)' },
  '.cm-panel.cm-search .cm-button:active': { backgroundImage: 'none', background: 'var(--active)', transform: 'translateY(1px)' },
  '.cm-panel.cm-search .cm-button:focus-visible, .cm-panel.cm-search [name=close]:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '1px',
  },
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: 'var(--muted)',
    fontSize: 'var(--fs-small)',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search input[type=checkbox]': { margin: '0', accentColor: 'var(--accent)' },
  '.cm-panel.cm-search [name=close]': {
    top: '8px',
    right: '8px',
    margin: '0',
    padding: '0',
    border: 'none',
    width: '28px',
    height: '28px',
    borderRadius: 'var(--radius-control)',
    color: 'var(--muted)',
    background: 'none',
    fontSize: 'var(--fs-large)',
    lineHeight: 'var(--lh-tight)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover': { background: 'var(--hover)', color: 'var(--text)' },
  // Matches: every one amber, the current one the accent with a ring, so it stands out in both themes.
  '.cm-searchMatch': {
    background: 'var(--warn-bg)',
    outline: '1px solid var(--warning)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    background: 'var(--accent-soft)',
    outline: '2px solid var(--accent)',
  },
  '.cm-jump': { background: 'var(--accent-soft)' },
  // Compare (#303): the agent's lines green (with a bar in the gutter), the lines only I have amber.
  '.cm-deletedChunk': { background: 'var(--pos-bg) !important', color: 'var(--text)', borderLeft: '3px solid var(--positive)' },
  '.cm-deletedChunk del, .cm-deletedText': { textDecoration: 'none', background: 'transparent !important' },
  '.cm-changedLine, .cm-insertedLine': { background: 'var(--warn-bg) !important' },
  '.cm-changedText, .cm-insertedText': { background: 'transparent !important' },
  '.cm-changeGutter': { width: '3px', paddingLeft: '0' },
  '.cm-changedLineGutter': { background: 'var(--warn-ink)' },
  '.cm-chunkButtons button': {
    fontFamily: 'var(--font)',
    fontSize: 'var(--fs-small)',
  },
});

export const CodeEditor = forwardRef<
  CodeEditorHandle,
  {
    /** The text it starts with; a new `docKey` starts again (another file, or a reload). */
    initial: string;
    docKey: string;
    lang: Lang | null;
    readOnly: boolean;
    /** Line to show and put the cursor on; a new `lineKey` jumps again. */
    line: number | null;
    lineKey: string;
    /** Compare (#303): the agent's version beside mine, as a unified diff; null hides it. */
    compare: string | null;
    onChange(text: string): void;
    onSave(): void;
    /** The first and last lines on screen, at each scroll, resize or edit. */
    onLines?(from: number, to: number): void;
    /** Comments on lines: marks always; picks (click a line number, shift-click or drag for a range) while `on`. */
    comment?: PaneComment;
  }
>(function CodeEditor(props, ref) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const comp = useRef({
    lang: new Compartment(),
    ro: new Compartment(),
    merge: new Compartment(),
  });
  // Latest callbacks, so the extensions made once call the current ones.
  const cb = useRef(props);
  cb.current = props;
  // Comment mode on lines: the drag shows as a mark (n = ''), the release opens the box under the lines.
  const last = useRef<number | null>(null);
  const showMarks = (v: EditorView, drag?: LineMark) => {
    const c = cb.current.comment;
    const marks: LineMark[] = (c?.marks ?? []).flatMap(({ n, mark }) => (mark.lines ? [{ n, from: mark.lines[0], to: mark.lines[1] }] : []));
    v.dispatch({ effects: setMarks.of(drag ? [...marks, drag] : marks) });
  };
  const pickStart = (v: EditorView, line: number, e: MouseEvent): boolean => {
    if (!cb.current.comment?.on || e.button !== 0) return false;
    e.preventDefault();
    const start = e.shiftKey && last.current !== null ? last.current : line;
    let end = line;
    const lineAt = (y: number) => v.state.doc.lineAt(v.lineBlockAtHeight(y - v.documentTop).from).number;
    const span = () => ({ from: Math.min(start, end), to: Math.max(start, end) });
    showMarks(v, { n: '', ...span() });
    const move = (m: MouseEvent) => {
      const l = lineAt(m.clientY);
      if (l === end) return;
      end = l;
      showMarks(v, { n: '', ...span() });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const { from, to } = span();
      last.current = from === to ? from : null;
      const top = v.lineBlockAt(v.state.doc.line(from).from).top + v.documentTop;
      const bottom = v.lineBlockAt(v.state.doc.line(to).from).bottom + v.documentTop;
      const r = v.contentDOM.getBoundingClientRect();
      cb.current.comment?.onPick(
        { anchor: { type: 'lines', from, to }, rect: { x: r.left, y: top, w: Math.min(r.width, v.scrollDOM.clientWidth), h: bottom - top }, mark: { style: 'hl', lines: [from, to] }, thumb: null },
        0,
      );
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return true;
  };
  // The first and last lines on screen (1-based), for « what the agent sees » (#305).
  const report = (v: EditorView) => {
    if (!cb.current.onLines) return;
    // Measured in CodeMirror's read phase (never layout reads inside an update).
    v.requestMeasure({
      key: 'atlas-lines',
      read: (view) => {
        const s = view.scrollDOM;
        const top = Math.max(0, s.getBoundingClientRect().top - view.documentTop);
        const doc = view.state.doc;
        return [doc.lineAt(view.lineBlockAtHeight(top).from).number, doc.lineAt(view.lineBlockAtHeight(top + Math.max(1, s.clientHeight) - 1).from).number] as const;
      },
      write: ([from, to]) => cb.current.onLines?.(from, to),
    });
  };

  useImperativeHandle(ref, () => ({
    text: () => view.current?.state.doc.toString() ?? '',
    setText: (text) => {
      const v = view.current;
      if (v)
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: text },
        });
    },
    focus: () => view.current?.focus(),
  }));

  useEffect(() => {
    const c = comp.current;
    const v = new EditorView({
      parent: box.current!,
      state: EditorState.create({
        doc: props.initial,
        extensions: [
          lineNumbers({ domEventHandlers: { mousedown: (v, line, e) => pickStart(v, v.state.doc.lineAt(line.from).number, e as MouseEvent) } }),
          commentLines,
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(highlight),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => (cb.current.onSave(), true),
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          theme,
          EditorView.contentAttributes.of({ 'aria-label': 'File text' }),
          c.lang.of([]),
          c.ro.of(EditorState.readOnly.of(props.readOnly)),
          c.merge.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.viewportChanged || u.geometryChanged) report(u.view);
          }),
          // « What the agent sees » (#305): the lines on screen follow the scroll.
          EditorView.domEventHandlers({ scroll: (_e, view) => report(view) }),
        ],
      }),
    });
    view.current = v;
    report(v);
    return () => {
      v.destroy();
      view.current = null;
    };
    // A new document (docKey) builds a new editor: undo history belongs to one file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey]);

  useEffect(() => {
    let live = true;
    const load = props.lang ? LANGS[props.lang] : null;
    if (!load) return;
    load().then(
      (ext) => live && view.current?.dispatch({ effects: comp.current.lang.reconfigure(ext) }),
      // A missing language chunk (offline after an update): plain text, said in the console, never a broken editor.
      (e: unknown) => console.error('Files: could not load the language for', props.lang, e),
    );
    return () => {
      live = false;
    };
  }, [props.lang, props.docKey]);

  useEffect(() => {
    view.current?.dispatch({
      effects: comp.current.ro.reconfigure(EditorState.readOnly.of(props.readOnly)),
    });
  }, [props.readOnly, props.docKey]);

  useEffect(() => {
    const ext =
      props.compare === null
        ? []
        : unifiedMergeView({
            original: props.compare,
            mergeControls: false,
            gutter: true,
          });
    view.current?.dispatch({ effects: comp.current.merge.reconfigure(ext) });
  }, [props.compare, props.docKey]);

  useEffect(() => {
    const v = view.current;
    if (!v || !props.line) return;
    const n = Math.min(props.line, v.state.doc.lines);
    const at = v.state.doc.line(n);
    v.dispatch({
      selection: { anchor: at.from },
      effects: EditorView.scrollIntoView(at.from, { y: 'center' }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.lineKey, props.docKey]);

  // The comments' marks follow the list (added, removed, renumbered) and the mode.
  const markKey = JSON.stringify(props.comment?.marks.map((m) => [m.n, m.mark.lines]) ?? []);
  useEffect(() => {
    if (view.current) showMarks(view.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markKey, props.docKey]);

  return <div ref={box} className={'wb-cm' + (props.comment?.on ? ' wb-commenting' : '')} />;
});

export default CodeEditor;
