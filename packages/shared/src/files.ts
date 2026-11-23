import { z } from 'zod';

/*
 * Files of any kind attached to a message or a task (#348). A picture stays a picture (an image block the model sees);
 * any other file is copied into the agent's workspace and named to it in one text line (path, size, kind): the model
 * never gets its bytes, the agent opens it with its tools. The UI reads the same line back to show the file's chip.
 */

/** A file attached to a task that isn't a picture: in <data>/task-images/, copied into the assignee's workspace. */
export const TaskFile = z.object({
  path: z.string(),
  bytes: z.number().int(),
  media_type: z.string(),
});
export type TaskFile = z.infer<typeof TaskFile>;

/** extension → [media type, what it is in plain words]. Anything else: application/octet-stream, « EXT file ». */
const KINDS: Record<string, [string, string]> = {
  pdf: ['application/pdf', 'PDF document'],
  csv: ['text/csv', 'CSV'],
  tsv: ['text/tab-separated-values', 'TSV'],
  txt: ['text/plain', 'text file'],
  log: ['text/plain', 'log file'],
  md: ['text/markdown', 'Markdown'],
  json: ['application/json', 'JSON'],
  jsonl: ['application/jsonl', 'JSON lines'],
  ndjson: ['application/x-ndjson', 'JSON lines'],
  yaml: ['application/yaml', 'YAML'],
  yml: ['application/yaml', 'YAML'],
  toml: ['application/toml', 'TOML'],
  xml: ['application/xml', 'XML'],
  html: ['text/html', 'HTML page'],
  htm: ['text/html', 'HTML page'],
  sql: ['application/sql', 'SQL'],
  parquet: ['application/vnd.apache.parquet', 'Parquet data'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel workbook'],
  xls: ['application/vnd.ms-excel', 'Excel workbook'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word document'],
  doc: ['application/msword', 'Word document'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint deck'],
  key: ['application/vnd.apple.keynote', 'Keynote deck'],
  numbers: ['application/vnd.apple.numbers', 'Numbers sheet'],
  pages: ['application/vnd.apple.pages', 'Pages document'],
  zip: ['application/zip', 'zip archive'],
  gz: ['application/gzip', 'compressed file'],
  tgz: ['application/gzip', 'compressed archive'],
  tar: ['application/x-tar', 'tar archive'],
  '7z': ['application/x-7z-compressed', '7z archive'],
  rar: ['application/vnd.rar', 'rar archive'],
  sqlite: ['application/vnd.sqlite3', 'SQLite database'],
  db: ['application/octet-stream', 'database'],
  mp3: ['audio/mpeg', 'audio file'],
  wav: ['audio/wav', 'audio file'],
  m4a: ['audio/mp4', 'audio file'],
  ogg: ['audio/ogg', 'audio file'],
  flac: ['audio/flac', 'audio file'],
  mp4: ['video/mp4', 'video'],
  mov: ['video/quicktime', 'video'],
  webm: ['video/webm', 'video'],
  png: ['image/png', 'PNG image'],
  jpg: ['image/jpeg', 'JPEG image'],
  jpeg: ['image/jpeg', 'JPEG image'],
  gif: ['image/gif', 'GIF image'],
  webp: ['image/webp', 'WebP image'],
  svg: ['image/svg+xml', 'SVG image'],
  heic: ['image/heic', 'HEIC image'],
  ts: ['text/plain', 'TypeScript'],
  js: ['text/plain', 'JavaScript'],
  py: ['text/plain', 'Python'],
  go: ['text/plain', 'Go'],
  rs: ['text/plain', 'Rust'],
  sh: ['text/plain', 'shell script'],
};

/** The lower-case extension of a file name ('' when none). */
export function extOfName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** What a file is, from its name: its media type, a plain label, the chip's mark (its extension, ≤ 4 letters, else null). */
export function fileInfo(name: string): { mediaType: string; label: string; mark: string | null } {
  const ext = extOfName(name);
  const known = KINDS[ext];
  const mark = ext && ext.length <= 4 && /^[a-z0-9]+$/.test(ext) ? ext.toUpperCase() : null;
  if (known) return { mediaType: known[0], label: known[1], mark };
  return { mediaType: 'application/octet-stream', label: ext && ext.length <= 8 ? `${ext.toUpperCase()} file` : 'file', mark };
}

/** What a browser shows in a tab (pdf, audio, video, pictures, plain text); the rest is downloaded. */
export function opensInTab(name: string): boolean {
  const t = fileInfo(name).mediaType;
  return t === 'application/pdf' || /^(audio|video)\//.test(t) || /^image\/(png|jpeg|gif|webp)$/.test(t) || /^text\/(plain|csv|markdown|tab-separated-values)$/.test(t) || t === 'application/json';
}

/** « 3 KB », « 612 KB », « 4.8 MB ». */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TAIL = 'not sent to you: open it with your tools';
/** The line the agent reads for an attached file (its path relative to the workspace), and the UI parses back. */
export const fileLine = (rel: string, bytes: number, name = rel) => `[file attached: ${rel} (${sizeLabel(bytes)}, ${fileInfo(name).label}), ${TAIL}]`;

/** A file line's parts, or null when the text isn't one. */
export function parseFileLine(t: string): { path: string; size: string; label: string } | null {
  const m = /^\[file attached: (\S+) \(([^,()]+), ([^()]+)\), not sent to you: open it with your tools\]$/.exec(t);
  return m ? { path: m[1]!, size: m[2]!, label: m[3]! } : null;
}
