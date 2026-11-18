import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Project } from '@atlas/shared';
import { Menu, PopRow } from './HeadMenu.tsx';
import { Icon } from './ScreenHeader.tsx';

/**
 * Projects in the UI (#217, mockup #212). With a single project the app looks exactly as before: no sidebar groups,
 * no tags, no crumb, no filter. Everything here renders nothing until a second project exists.
 */
export interface ProjectsInfo {
  /** Every project, archived ones too, oldest first. */
  all: Project[];
  active: Project[];
  /** Two projects or more (archived ones count: their items need the filter's « Archived »). */
  multi: boolean;
  byId(id: string | null | undefined): Project | undefined;
}

export function projectsInfo(all: Project[]): ProjectsInfo {
  const active = all.filter((p) => p.status === 'active');
  return { all, active, multi: all.length >= 2, byId: (id) => (id ? all.find((p) => p.id === id) : undefined) };
}

export const ProjectsCtx = createContext<ProjectsInfo>(projectsInfo([]));
export const useProjects = () => useContext(ProjectsCtx);

/** A project's mark: a small rounded square in its hue. */
export function ProjDot({ hue, className }: { hue: number; className?: string }) {
  return <span className={'proj-dot' + (className ? ' ' + className : '')} style={{ ['--ph' as string]: hue }} aria-hidden="true" />;
}

/**
 * The project tag on cards, rows and Inbox items: only with two projects or more. `global`: an item with no project
 * (a workflow, a secret) reads « Global ».
 */
export function ProjTag({ id, title, global }: { id: string | null | undefined; title?: string; global?: boolean }) {
  const { multi, byId } = useProjects();
  if (!multi) return null;
  const p = byId(id);
  if (!p) return global ? <span className="proj-tag" title={title ?? 'Project'}>Global</span> : null;
  return (
    <span className="proj-tag" title={title ?? 'Project'}>
      <ProjDot hue={p.colour} />
      {p.name}
    </span>
  );
}

/** The project filter's value: every project, items with no project (Memory, Secrets), archived projects, or one project id. */
export type ProjectFilter = 'all' | 'global' | 'archived' | string;
const KEY = 'atlas.project';
const CHANGED = 'atlas-project-filter';

/** One filter for Tasks, Library, Workflows, Memory and Secrets, kept across reloads (like atlas.board.view). */
export function useProjectFilter(): [ProjectFilter, (f: ProjectFilter) => void] {
  const [f, setF] = useState<ProjectFilter>(() => localStorage.getItem(KEY) || 'all');
  useEffect(() => {
    const on = () => setF(localStorage.getItem(KEY) || 'all');
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, []);
  const set = useCallback((next: ProjectFilter) => {
    localStorage.setItem(KEY, next);
    setF(next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return [f, set];
}

/**
 * The filter as it applies on this screen: one project leaves the app (deleted, or a single project left) → all;
 * « Global only » outside Memory and Secrets → all.
 */
export function effectiveFilter(f: ProjectFilter, info: ProjectsInfo, globalOnly = false): ProjectFilter {
  if (!info.multi) return 'all';
  if (f === 'all' || f === 'archived') return f;
  if (f === 'global') return globalOnly ? f : 'all';
  return info.byId(f) ? f : 'all';
}

/**
 * Is an item of `projectId` (null = global) shown under the filter `f` (already effective)? `withGlobal`: global items
 * (workflows, memories, secrets with no project) apply to every project, so one project's view shows them too.
 */
export function inFilter(f: ProjectFilter, projectId: string | null | undefined, info: ProjectsInfo, withGlobal = false): boolean {
  const p = info.byId(projectId);
  if (f === 'all') return !p || p.status === 'active';
  if (f === 'global') return !projectId;
  if (f === 'archived') return !!p && p.status === 'archived';
  return projectId === f || (withGlobal && !projectId);
}

/** The project a new item gets: the filter's project, else the default one. */
export function projectForNew(f: ProjectFilter, info: ProjectsInfo): Project | undefined {
  const p = info.byId(f);
  return p && p.status === 'active' ? p : (info.active.find((x) => x.isDefault) ?? info.active[0]);
}

/**
 * The project filter: one head button, the same on Tasks, Library, Workflows, Memory and Secrets (+ « Global only » on
 * the last two). `count(f)`: how many items each choice shows. Nothing with a single project.
 */
export function ProjectFilterButton(props: {
  value: ProjectFilter;
  onChange(f: ProjectFilter): void;
  count(f: ProjectFilter): number;
  globalOnly?: boolean;
}) {
  const info = useProjects();
  const [open, setOpen] = useState(false);
  if (!info.multi) return null;
  const v = effectiveFilter(props.value, info, props.globalOnly);
  const cur = info.byId(v);
  const pick = (f: ProjectFilter) => (props.onChange(f), setOpen(false));
  const row = (f: ProjectFilter, label: ReactNode) => (
    <PopRow key={f} on={v === f} onClick={() => pick(f)}>
      {label}
      <span className="tab-n">{props.count(f)}</span>
    </PopRow>
  );
  return (
    <Menu
      className="proj-menu"
      btnClass="proj-btn"
      open={open}
      onOpen={setOpen}
      title="Project"
      label={
        <>
          <span className="btn-text proj-btn-text">
            {cur ? (
              <span className="proj-crumb">
                <ProjDot hue={cur.colour} />
                {cur.name}
              </span>
            ) : v === 'global' ? (
              'Global only'
            ) : v === 'archived' ? (
              'Archived'
            ) : (
              'All projects'
            )}
          </span>
          <Icon.chevDown />
        </>
      }
    >
      {row('all', <span>All projects</span>)}
      {props.globalOnly && row('global', <span>Global only</span>)}
      {info.active.map((p) =>
        row(
          p.id,
          <>
            <ProjDot hue={p.colour} />
            <span>{p.name}</span>
          </>,
        ),
      )}
      <div className="pop-sep" />
      {row('archived', <span>Archived</span>)}
      <button type="button" className="pop-row" onClick={() => ((location.hash = '#/settings/projects'), setOpen(false))}>
        Manage projects…
      </button>
    </Menu>
  );
}
