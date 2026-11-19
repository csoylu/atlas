import { useEffect, useState } from 'react';
import type { Doc, Folder } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import type { Artifact } from './cardModal.ts';
import type { CanvasPage } from './chatTurn.ts';

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
export const fileUrl = (doc: Pick<Doc, 'agentId' | 'path'> & { filesRoot?: string }) => `/api/files/${encodeURIComponent(doc.filesRoot ?? doc.agentId)}/${doc.path.split('/').map(encodeURIComponent).join('/')}`;

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
 * latest » once it moved on. One Library fetch is shared by every card (archived projects' artifacts included);
 * document.updated events keep it current. A card whose artifact is not in it is checked once (#242): a 404 means it
 * was deleted, and document.deleted events mark the others.
 */
const latest = new Map<string, number>();
const deletedIds = new Set<string>();
let latestLoad: Promise<void> | null = null;
/** One Library fetch for the latest versions and the converted canvases (a failed fetch is retried by the next user). */
function loadLatest(): Promise<void> {
  latestLoad ??= api.documents(undefined, true).then(
    (ds) =>
      ds.forEach((d) => {
        latest.set(d.id, Math.max(d.version, latest.get(d.id) ?? 0));
        noteCanvas(d);
      }),
    (e: unknown) => {
      latestLoad = null;
      throw e;
    },
  );
  return latestLoad;
}

/** Not in the Library fetch: deleted (404), or made since (its versions say its latest). */
const probes = new Map<string, Promise<void>>();
function probe(docId: string): Promise<void> {
  let p = probes.get(docId);
  if (!p) {
    p = api.docVersions(docId).then(
      (vs) => void (vs[0] && latest.set(docId, Math.max(vs[0].version, latest.get(docId) ?? 0))),
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 404) deletedIds.add(docId);
        else {
          probes.delete(docId); // tried again by the next card
          throw e;
        }
      },
    );
    probes.set(docId, p);
  }
  return p;
}

/** A converted canvas page as the chat's artifact chip (#174): its latest version, never « Updated to ». */
export const canvasArtifact = (d: Pick<Doc, 'id' | 'title' | 'path' | 'kind' | 'version'>): Artifact => ({
  docId: d.id,
  version: d.version,
  title: d.title,
  where: d.path,
  kind: d.kind,
  section: null,
  updated: false,
});
const canvasPages = new Map<string, Artifact>();
const noteCanvas = (d: Doc) => void (d.fromCanvas && canvasPages.set(d.fromCanvas, canvasArtifact(d)));

/**
 * Old chats' canvas_* rows (#174): cv_ id → the html page it was converted to (#120), from the same Library fetch.
 * Re-renders once the fetch lands.
 */
export function useCanvasPages(): CanvasPage {
  const [, setLoaded] = useState(latestLoad !== null && canvasPages.size > 0);
  useEffect(() => {
    let live = true;
    loadLatest().then(
      () => live && setLoaded(true),
      (e: unknown) => console.error('Library fetch for canvas pages failed', e),
    );
    return () => {
      live = false;
    };
  }, []);
  return (id) => canvasPages.get(id);
}

/** A chat card's artifact, live: its latest version, and whether it was deleted (#242). */
export interface ArtifactState {
  latest: number | null;
  deleted: boolean;
}
/** An artifact deleted for good (document.deleted, #242): its chat cards say so. */
export function noteDeleted(docId: string): void {
  deletedIds.add(docId);
  latest.delete(docId);
}
const stateOf = (docId: string): ArtifactState => ({ latest: latest.get(docId) ?? null, deleted: deletedIds.has(docId) });
export function useArtifactState(docId: string, stream: MessageStream): ArtifactState {
  const [st, setSt] = useState<ArtifactState>(() => stateOf(docId));
  useEffect(() => {
    let live = true;
    const update = () => live && setSt(stateOf(docId));
    loadLatest()
      .then(() => (latest.has(docId) || deletedIds.has(docId) ? undefined : probe(docId)))
      .then(update, (e: unknown) => console.error(`artifact ${docId}: could not read its latest version`, e));
    const off = stream.listen('docs', (e) => {
      if (e.type === 'doc') {
        latest.set(e.doc.id, e.doc.version);
        noteCanvas(e.doc);
        if (e.doc.id === docId) update();
      } else if (e.type === 'docDeleted') {
        noteDeleted(e.id);
        if (e.id === docId) update();
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [docId, stream]);
  return st;
}
