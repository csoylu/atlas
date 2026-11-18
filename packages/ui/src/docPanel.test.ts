import { describe, expect, it } from 'vitest';
import { activeTab, byline, CHAT_MIN, diagramWidth, PANEL_MIN, panelBounds, panelKey, panelMode, panelWidth, parsePanelWidth } from './docPanel.ts';
import type { PanelTab } from '@atlas/shared';

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
