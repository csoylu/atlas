import type { GitLetter, WsFile } from '@atlas/shared';
import type { PanelMode } from './docPanel.ts';

/**
 * The Files tab of the workbench (#303, mockup « the right pane as a workbench », Files screens): pure helpers, tested
 * in files.test.ts. The tree sits beside the editor in a wide side pane; below 560 px (and in an overlay or on a phone)
 * it takes the whole pane and picking a file shows the editor.
 */

/** Narrowest side pane that shows the tree beside the editor. */
export const TREE_BESIDE_MIN = 560;

export const treeBeside = (mode: PanelMode, width: number): boolean => mode === 'side' && width >= TREE_BESIDE_MIN;

/** A file tab's title: the file's name; the workspace itself (path '') is « Files ». */
export const fileTitle = (path: string): string => (path ? path.slice(path.lastIndexOf('/') + 1) : 'Files');

/** « publish-atlas/packages/ui/src/ » and « docPanel.ts », for the bar (the name in bold). */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return { dir: i < 0 ? '' : path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** Every folder above `path`, outermost first: « a/b/c.ts » → [a, a/b]. */
export function ancestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** 3.1 MB, 420 KB, 12 bytes. */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
}

/** The git letter's tooltip. */
export const gitTitle = (g: GitLetter, agent: string): string => (g === 'A' ? `Added by ${agent}` : `Changed by ${agent}`);

/** What a binary file is, in plain words, from its name. */
export function binaryWhat(path: string, size: number): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const kind: Record<string, string> = {
    sqlite: 'SQLite database',
    sqlite3: 'SQLite database',
    db: 'database',
    zip: 'zip archive',
    gz: 'compressed file',
    tgz: 'compressed archive',
    pdf: 'PDF document',
    woff: 'font',
    woff2: 'font',
    ttf: 'font',
    otf: 'font',
    mp3: 'audio file',
    wav: 'audio file',
    mp4: 'video',
    mov: 'video',
    onnx: 'model file',
    gguf: 'model file',
    bin: 'binary file',
    dmg: 'disk image',
  };
  return kind[ext] ? `${kind[ext]}, ${fmtBytes(size)}` : fmtBytes(size);
}

/** What the bar says on the right, from the open file's state. */
export type FileState = { kind: 'saved' } | { kind: 'unsaved' } | { kind: 'saving' } | { kind: 'ro'; label: string };

export function fileState(file: WsFile | null, dirty: boolean, saving: boolean, image: { w: number; h: number } | null): FileState {
  if (saving) return { kind: 'saving' };
  if (dirty) return { kind: 'unsaved' };
  if (file?.readOnly === 'binary') return { kind: 'ro', label: 'Read only · binary' };
  if (file?.readOnly === 'large') return { kind: 'ro', label: `Read only · ${fmtBytes(file.size)}` };
  if (file?.readOnly === 'secret') return { kind: 'ro', label: 'Read only · secret' };
  if (file?.readOnly === 'image')
    return {
      kind: 'ro',
      label: image ? `${image.w} × ${image.h}` : fmtBytes(file.size),
    };
  return { kind: 'saved' };
}

/** The editor's language for a file name (null: plain text). Each loads on its own when first needed. */
export type Lang = 'js' | 'ts' | 'jsx' | 'tsx' | 'json' | 'css' | 'html' | 'markdown' | 'python' | 'yaml';

export function langOf(path: string): Lang | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const map: Record<string, Lang> = {
    js: 'js',
    mjs: 'js',
    cjs: 'js',
    jsx: 'jsx',
    ts: 'ts',
    mts: 'ts',
    cts: 'ts',
    tsx: 'tsx',
    json: 'json',
    jsonc: 'json',
    css: 'css',
    scss: 'css',
    html: 'html',
    htm: 'html',
    svg: 'html',
    xml: 'html',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    yml: 'yaml',
    yaml: 'yaml',
  };
  return map[ext] ?? null;
}

/** The tree row's icon kind. */
export function rowIcon(path: string): 'code' | 'md' | 'image' | 'file' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'].includes(ext)) return 'image';
  if (['md', 'markdown', 'txt'].includes(ext)) return 'md';
  return langOf(path) ? 'code' : 'file';
}

/* ── File paths in chat messages (#303) ────────────────────────────────── */

/**
 * A file path written as inline code in a message: `src/pages/Tenders.tsx:42` → { path, line: 42 }. It needs a folder
 * or an extension (`README.md`, `src/x`), no spaces, no URL scheme; `:N` and `:N:C` give the line. Anything else: null.
 */
export function parsePathRef(text: string): { path: string; line: number | null } | null {
  const t = text.trim();
  if (!t || t.length > 300 || /\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  const m = /^(.+?)(?::(\d+)(?::\d+)?)?$/.exec(t);
  if (!m) return null;
  const path = m[1]!;
  if (!/^(?:~?\/|\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+\-[\]()]+)*\/?$/.test(path)) return null;
  if (path.endsWith('/')) return null;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  // Without a folder, only a known file extension (`api.panelOpen` is code, not a file).
  if (!path.includes('/') && !FILE_EXTS.has(ext)) return null;
  if (/^\d+(\.\d+)*$/.test(name)) return null; // a version number, not a file
  if (path.startsWith('~')) return null; // the home folder is never in the workspace
  const line = m[2] ? Number(m[2]) : null;
  return { path, line: line && line > 0 ? line : null };
}

const FILE_EXTS = new Set(
  'ts tsx js jsx mjs cjs mts cts json jsonc md markdown txt css scss html htm svg xml py rb go rs java kt swift c h cpp hpp cs php sh bash zsh yml yaml toml ini cfg conf env lock sql csv tsv log png jpg jpeg gif webp avif ico pdf mm m vue svelte astro graphql proto dockerfile makefile gitignore'.split(
    ' ',
  ),
);
