import { describe, expect, it } from 'vitest';
import { activeTab, ADD_MAX, artifactChoices, byline, CHAT_MIN, diagramWidth, PANEL_MIN, panelBounds, panelKey, panelMode, panelWidth, parsePanelWidth, SCREEN_MIN, taskPanelMode } from './docPanel.ts';
import type { Doc, PanelTab } from '@atlas/shared';

describe('side panel helpers', () => {
  it('chooses side by side, overlay or full screen by viewport width', () => {
    expect(panelMode(1440)).toBe('side');
    expect(panelMode(961)).toBe('side');
    expect(panelMode(960)).toBe('overlay');
    expect(panelMode(761)).toBe('overlay');
    expect(panelMode(390)).toBe('full');
  });

  it('keeps the dragged panel width inside the chat view (#211)', () => {
    // Default = the former CSS: 48% of the view between 380 and 760 side by side, min(560, 94%) over the chat.
    expect(panelBounds(1380, 'side')).toEqual({ min: PANEL_MIN, max: 1380 - CHAT_MIN, def: 662 });
    expect(panelBounds(2000, 'side').def).toBe(760);
    expect(panelBounds(840, 'overlay')).toEqual({ min: PANEL_MIN, max: 789, def: 560 });
    expect(panelWidth(null, 1380, 'side')).toBe(662);
    expect(panelWidth(500, 1380, 'side')).toBe(500);
    expect(panelWidth(100, 1380, 'side')).toBe(PANEL_MIN); // too narrow
    // The window shrinks: the stored width is clamped so the chat keeps CHAT_MIN and the panel stays on screen.
    expect(panelWidth(1000, 1380, 'side')).toBe(1000);
    expect(panelWidth(1000, 1000, 'side')).toBe(1000 - CHAT_MIN);
    expect(panelWidth(1000, 840, 'overlay')).toBe(789);
    // A view too small for both: the panel keeps its minimum, never more than the view allows.
    expect(panelWidth(900, 600, 'side')).toBe(PANEL_MIN);
    expect(panelBounds(300, 'overlay')).toEqual({ min: 300, max: 300, def: 300 });
    // A two-pane screen beside the task panel keeps SCREEN_MIN (#222).
    expect(panelBounds(1100, 'side', SCREEN_MIN).max).toBe(1100 - SCREEN_MIN);
    expect(panelWidth(800, 1100, 'side', SCREEN_MIN)).toBe(1100 - SCREEN_MIN);
  });

  it('reads the stored width and moves it with the keyboard', () => {
    expect(parsePanelWidth(null)).toBeNull();
    expect(parsePanelWidth('abc')).toBeNull();
    expect(parsePanelWidth('-4')).toBeNull();
    expect(parsePanelWidth('512.4')).toBe(512);
    const b = { min: 360, max: 1000 };
    expect(panelKey('ArrowLeft', false, 500, b)).toBe(516);
    expect(panelKey('ArrowRight', true, 500, b)).toBe(436);
    expect(panelKey('ArrowRight', false, 365, b)).toBe(360);
    expect(panelKey('Home', false, 500, b)).toBe(1000);
    expect(panelKey('End', false, 500, b)).toBe(360);
    expect(panelKey('a', false, 500, b)).toBeNull();
  });

  it('fits a diagram to the width unless its text would get too small', () => {
    const svg = (w: number, fs: number) => `<svg viewBox="0 0 ${w} 150" font-size="${fs}"><text>x</text></svg>`;
    expect(diagramWidth(svg(620, 15), 600)).toBe(600); // 15 * 600/620 ≈ 14.5px ≥ 11
    expect(diagramWidth(svg(2000, 12), 600)).toBe(1834); // keep 11px text: 2000 * 11/12
    expect(diagramWidth('<svg width="900px"><text style="font-size: 9px">a</text></svg>', 500)).toBe(1100);
    expect(diagramWidth('<svg viewBox="0 0 800 400"><rect/></svg>', 500)).toBe(500); // no text
    expect(diagramWidth('<svg><text>a</text></svg>', 500)).toBe(500); // unknown size
  });

  it('says who opened a tab and which card it belongs to', () => {
    expect(byline({ openedBy: 'atlas', cardTitle: 'Permissions design' }, 'Can')).toBe('Opened by @atlas · attached to card “Permissions design”');
    expect(byline({ openedBy: 'user', cardTitle: null }, 'Can')).toBe('Opened by Can');
  });

  it('shows the active tab, else the last', () => {
    const t = (id: string, active: boolean) => ({ doc: { id }, active }) as unknown as PanelTab;
    expect(activeTab([t('a', false), t('b', true), t('c', false)])!.doc.id).toBe('b');
    expect(activeTab([t('a', false), t('c', false)])!.doc.id).toBe('c');
    expect(activeTab([])).toBeUndefined();
  });
});

describe('taskPanelMode (#222)', () => {
  it('sits beside the screen when both minimum widths fit, else over it from the right; phones stay full screen', () => {
    expect(taskPanelMode('side', 1380, CHAT_MIN)).toBe('side');
    expect(taskPanelMode('side', 1030, SCREEN_MIN)).toBe('side');
    expect(taskPanelMode('side', 990, SCREEN_MIN)).toBe('overlay');
    expect(taskPanelMode('side', 700, CHAT_MIN)).toBe('overlay');
    expect(taskPanelMode('side', 0, CHAT_MIN)).toBe('side'); // not measured yet
    expect(taskPanelMode('overlay', 1400, CHAT_MIN)).toBe('overlay');
    expect(taskPanelMode('full', 1400, CHAT_MIN)).toBe('full');
  });
});

describe('artifactChoices (#302, the + menu)', () => {
  const d = (id: string, title: string, updatedAt: string, projectId = 'atlas', path = `docs/${id}.md`) => ({ id, title, path, updatedAt, projectId }) as unknown as Doc;
  const docs = [d('a', 'Build plan', '2026-11-18'), d('b', 'Settings mockup', '2026-11-20', 'atlas', 'pages/settings.html'), d('c', 'Tenders', '2026-11-19', 'datinel'), d('e', 'Browser design', '2026-11-19')];
  it("lists the chat's project's artifacts not open yet, latest first", () => {
    expect(artifactChoices(docs, 'atlas', new Set(['e']), '').map((x) => x.id)).toEqual(['b', 'a']);
    expect(artifactChoices(docs, 'datinel', new Set(), '').map((x) => x.id)).toEqual(['c']);
  });
  it('keeps the artifacts matching every word in the title or path, any case', () => {
    expect(artifactChoices(docs, 'atlas', new Set(), 'PLAN build').map((x) => x.id)).toEqual(['a']);
    expect(artifactChoices(docs, 'atlas', new Set(), 'pages/').map((x) => x.id)).toEqual(['b']);
    expect(artifactChoices(docs, 'atlas', new Set(), 'nothing')).toEqual([]);
  });
  it('lists at most ADD_MAX', () => {
    const many = Array.from({ length: ADD_MAX + 5 }, (_, i) => d('m' + i, 'Doc ' + i, `2026-11-${String(i % 28 + 1).padStart(2, '0')}`));
    expect(artifactChoices(many, 'atlas', new Set(), '')).toHaveLength(ADD_MAX);
  });
});
