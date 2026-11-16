import { describe, expect, it } from 'vitest';
import { STROKE, sketchToSkeletons } from './sketch.ts';

describe('sketch', () => {
  it('passes colours through unchanged (the dark theme adapts them), default ink otherwise', () => {
    const [box, plain] = sketchToSkeletons([
      { id: 'a', type: 'rectangle', x: 0, y: 0, color: '#c92a2a', background: '#ffc9c9', label: 'A' },
      { id: 'b', type: 'rectangle', x: 200, y: 0 },
    ]) as { strokeColor: string; backgroundColor?: string; label?: { strokeColor: string } }[];
    expect(box).toMatchObject({ strokeColor: '#c92a2a', backgroundColor: '#ffc9c9', label: { strokeColor: '#c92a2a' } });
    expect(plain!.strokeColor).toBe(STROKE);
    expect(plain!.backgroundColor).toBeUndefined();
  });

  it('lays out connected arrows between box edges, whatever coordinates the model gave', () => {
    const [, , arrow] = sketchToSkeletons([
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', type: 'rectangle', x: 300, y: 0, width: 100, height: 50 },
      { type: 'arrow', x: 999, y: 999, from: 'a', to: 'b' },
    ]) as { x: number; y: number; width: number; height: number; start?: { id: string }; end?: { id: string } }[];
    expect(arrow!.x).toBeCloseTo(106);
    expect(arrow!.y).toBeCloseTo(25);
    expect(arrow!.width).toBeCloseTo(188);
    expect(arrow!.height).toBeCloseTo(0);
    expect(arrow!.start).toEqual({ id: 'a' });
    expect(arrow!.end).toEqual({ id: 'b' });
  });

  it('keeps free arrows and unknown ids as given', () => {
    const [arrow] = sketchToSkeletons([{ type: 'arrow', x: 5, y: 6, width: 50, from: 'nope' }]) as { x: number; width: number; start?: unknown }[];
    expect(arrow).toMatchObject({ x: 5, width: 50 });
    expect(arrow!.start).toBeUndefined();
  });
});
