import { describe, expect, it } from 'vitest';
import { activeTab, byline, diagramWidth, panelMode } from './docPanel.ts';
import type { PanelTab } from '@atlas/shared';

describe('side panel helpers', () => {
  it('chooses side by side, overlay or full screen by viewport width', () => {
    expect(panelMode(1440)).toBe('side');
    expect(panelMode(961)).toBe('side');
    expect(panelMode(960)).toBe('overlay');
    expect(panelMode(761)).toBe('overlay');
    expect(panelMode(390)).toBe('full');
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
