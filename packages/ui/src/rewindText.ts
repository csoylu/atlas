import type { FileChange } from '@atlas/shared';

/** The stop reason of a run ended by a rewind (engine rewind.ts). */
export const REWOUND = 'rewound by you';

/** « 3 files restored », « 1 file restored », « no files changed »: honest, files only. */
export function filesLine(files: FileChange[]): string {
  if (!files.length) return 'no files changed';
  return `${files.length} ${files.length === 1 ? 'file' : 'files'} restored`;
}
