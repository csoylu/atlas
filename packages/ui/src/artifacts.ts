import { useEffect, useState } from 'react';
import type { Doc, Folder } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';

/**
 * Artifacts (#120): what the viewer, the chat card and the Library share. Pages and links run in an opaque-origin
 * sandbox (scripts yes, access to Atlas no); a link to another origin (a dev server) also gets allow-same-origin, it is
 * cross-origin to Atlas anyway.
 */
export const SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';
export function sandboxFor(url: string): string {
  try {
    return new URL(url, location.href).origin === location.origin ? SANDBOX : SANDBOX + ' allow-same-origin';
  } catch {
    return SANDBOX;
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
/** A link to an image file: drawn with <img> fit to the box (an iframe shows it at natural size, zoomed in). */
export function isImageUrl(url: string): boolean {
  let path = url.trim();
  if (path.startsWith('data:image/')) return true;
  try {
    path = new URL(path, 'http://x').pathname;
  } catch {
    path = path.split(/[?#]/)[0] ?? '';
  }
  return IMAGE_EXT.test(path);
}

/** The file as served by the engine (html pages load relative assets from there). */
export const fileUrl = (doc: Pick<Doc, 'agentId' | 'path'>) => `/api/files/${encodeURIComponent(doc.agentId)}/${doc.path.split('/').map(encodeURIComponent).join('/')}`;

/** « vN » on the latest version, « vN of M » on an older one. */
export const versionLabel = (shown: number, latest: number) => (shown < latest ? `v${shown} of ${latest}` : `v${shown}`);

export const folderName = (folders: Folder[], id: string | null) => (id ? (folders.find((f) => f.id === id)?.name ?? 'Unfiled') : 'Unfiled');

/** The Library folders, live (one fetch shared by every user of the hook, then folders.updated events). */
let cache: Folder[] | null = null;
let loading: Promise<Folder[]> | null = null;
export function useFolders(stream: MessageStream, onError: (e: unknown) => void): Folder[] {
  const [folders, setFolders] = useState<Folder[]>(cache ?? []);
  useEffect(() => {
    let live = true;
    if (!cache) {
      loading ??= api.folders().finally(() => (loading = null));
      loading.then((f) => {
        cache = f;
        if (live) setFolders(f);
      }, onError);
    }
    const off = stream.listen('folders', (e) => {
      if (e.type !== 'folders') return;
      cache = e.folders;
      setFolders(e.folders);
    });
    return () => {
      live = false;
      off();
    };
  }, [stream, onError]);
  return folders;
}

/**
 * The latest version of an artifact, live: chat cards stay on the version they were posted with and say « · vN is the
 * latest » once it moved on. One Library fetch is shared by every card; document.updated events keep it current.
 */
const latest = new Map<string, number>();
let latestLoad: Promise<void> | null = null;
export function useLatestVersion(docId: string, stream: MessageStream): number | null {
  const [v, setV] = useState<number | null>(latest.get(docId) ?? null);
  useEffect(() => {
    let live = true;
    latestLoad ??= api.documents().then(
      (ds) => ds.forEach((d) => latest.set(d.id, Math.max(d.version, latest.get(d.id) ?? 0))),
      () => void (latestLoad = null),
    );
    void latestLoad.then(() => live && setV(latest.get(docId) ?? null));
    const off = stream.listen('docs', (e) => {
      if (e.type !== 'doc') return;
      latest.set(e.doc.id, e.doc.version);
      if (e.doc.id === docId && live) setV(e.doc.version);
    });
    return () => {
      live = false;
      off();
    };
  }, [docId, stream]);
  return v;
}
