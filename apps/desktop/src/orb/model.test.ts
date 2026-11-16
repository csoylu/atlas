import { describe, expect, it } from 'vitest';
import { bubbleSide, clampToArea, defaultOrbPosition, frameStats, isOnOrb, levelFromRms, placeOf, replyLineOnEnter, restoreOrb, rms, typeDelay, withSentence } from './model.ts';

const screen = { x: 0, y: 25, width: 1440, height: 850 }; // work area under a 25 pt menu bar

describe('orb model', () => {
  it('starts bottom-right of the work area', () => {
    expect(defaultOrbPosition(screen)).toEqual({ x: 1322, y: 725 });
  });

  it('keeps a dragged orb on screen, on any display', () => {
    expect(clampToArea({ x: 5000, y: -100 }, screen)).toEqual({ x: 1400, y: 65 });
    expect(clampToArea({ x: -1500, y: 400 }, { x: -1920, y: 0, width: 1920, height: 1080 })).toEqual({ x: -1500, y: 400 });
  });

  describe('position across displays (#51)', () => {
    // the real setup: 1512×982 laptop, 3440×1440 ultrawide (primary when connected), work areas under the menu bar
    const laptop = { id: 1, workArea: { x: 0, y: 33, width: 1512, height: 949 } };
    const laptopLeft = { id: 1, workArea: { x: -1512, y: 491, width: 1512, height: 949 } }; // beside the ultrawide
    const wide = { id: 5, workArea: { x: 0, y: 25, width: 3440, height: 1415 } };

    it('first launch: bottom-right of the primary display', () => {
      expect(restoreOrb(null, [wide, laptopLeft], 5)).toEqual({ display: 5, pos: { x: 3322, y: 1290 } });
    });

    it('same display, same size: exactly where it was dragged', () => {
      const place = placeOf({ x: 700, y: 400 }, laptop);
      expect(place).toEqual({ display: 1, x: 700, y: 367, width: 1512, height: 949 });
      expect(restoreOrb(place, [laptop], 1)).toEqual({ display: 1, pos: { x: 700, y: 400 } });
    });

    it('one display → two: the saved display moved to the left of the new primary, the orb follows it', () => {
      const place = placeOf({ x: 1443, y: 918 }, laptop);
      expect(restoreOrb(place, [wide, laptopLeft], 5)).toEqual({ display: 1, pos: { x: -1512 + 1443, y: 491 + 885 } });
    });

    it('saved display gone, a bigger one instead: same corner, not the same pixels (the bug: mid-ultrawide)', () => {
      const place = placeOf({ x: 1443, y: 918 }, laptop); // bottom-right of the laptop, 13 Nov
      const { display, pos } = restoreOrb(place, [wide], 5);
      expect(display).toBe(5);
      expect(pos).toEqual({ x: 3440 - (1512 - 1443), y: 25 + 1415 - (949 - 885) });
    });

    it('two displays → one smaller: corner kept, middle kept as a fraction, always on screen', () => {
      const corner = placeOf({ x: 60, y: 80 }, wide); // top-left
      expect(restoreOrb(corner, [laptop], 1).pos).toEqual({ x: 60, y: 33 + 55 });
      const middle = placeOf({ x: 1720, y: 732 }, wide); // centre of the ultrawide
      expect(restoreOrb(middle, [laptop], 1).pos).toEqual({ x: 756, y: 33 + Math.round((707 / 1415) * 949) });
      const edge = { display: 9, x: 3430, y: 1410, width: 3440, height: 1415 }; // hard against the corner
      expect(restoreOrb(edge, [laptop], 1).pos).toEqual({ x: 1512 - 40, y: 33 + 949 - 40 });
    });

    it('fails loudly if the primary display is missing from the list', () => {
      expect(() => restoreOrb(null, [laptop], 7)).toThrow(/primary display 7/);
    });
  });

  it('takes the mouse only on the orb: small ember at rest, the core when awake', () => {
    const orb = { x: 100, y: 100 };
    expect(isOnOrb({ x: 115, y: 100 }, orb, 'idle')).toBe(true);
    expect(isOnOrb({ x: 140, y: 100 }, orb, 'idle')).toBe(false);
    expect(isOnOrb({ x: 140, y: 100 }, orb, 'listening')).toBe(true);
    expect(isOnOrb({ x: 200, y: 100 }, orb, 'speaking')).toBe(false);
  });

  it('maps audio loudness to 0…1', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(0.001)).toBe(0); // -60 dBFS: silence
    expect(levelFromRms(0.0316)).toBeCloseTo(0.5, 1); // -30 dBFS
    expect(levelFromRms(1)).toBe(1);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
    expect(rms([])).toBe(0);
  });

  it('flips the caption to the right near the left edge', () => {
    expect(bubbleSide(1300)).toBe('left');
    expect(bubbleSide(200)).toBe('right');
    expect(bubbleSide(-1700, -1920)).toBe('right');
  });

  it('summarises frame times', () => {
    const f = frameStats([...Array(95).fill(16.6), 17, 18, 20, 40, 50]);
    expect(f).toMatchObject({ frames: 100, p50: 16.6, p95: 16.6, max: 50, long: 2 });
    expect(frameStats([])).toMatchObject({ frames: 0, p95: 0 });
  });

  it('paces the typewriter to the audio', () => {
    expect(typeDelay('Hello there.', 0.5)).toBeCloseTo(37.5);
    expect(typeDelay('Two cards are running.', 1.5)).toBe(60);
    expect(typeDelay('x'.repeat(1000), 1)).toBe(12);
  });

  it('shows « Yes, Master? » once after the wake word (card #40)', () => {
    // wake → the ack spoken → listening, as the voice loop drives the caption's reply line
    let line = replyLineOnEnter('wake')!;
    line = withSentence(line, 'Yes, Master?');
    expect(line).toBe('Yes, Master?');
    expect(replyLineOnEnter('listening')).toBe('');
    // a reply: each spoken sentence is appended once
    let reply = replyLineOnEnter('speaking')!;
    for (const s of ['Three cards.', 'One is blocked.']) reply = withSentence(reply, s);
    expect(reply).toBe('Three cards. One is blocked.');
    expect(replyLineOnEnter('idle')).toBeUndefined();
  });
});
