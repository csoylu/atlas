import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './store/db.ts';
import { Settings } from './settings.ts';

describe('Settings: voice orb position', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('is null until the orb is moved, then rounded and stored', () => {
    const s = new Settings(openDb(':memory:'));
    expect(s.orbPosition()).toBeNull();
    s.setOrbPosition({ display: 5, x: 1320.6, y: 801.2, width: 3440, height: 1415 });
    expect(s.orbPosition()).toEqual({ display: 5, x: 1321, y: 801, width: 3440, height: 1415 });
    s.setOrbPosition({ display: 1, x: 40, y: 20, width: 1512, height: 949 });
    expect(s.orbPosition()).toEqual({ display: 1, x: 40, y: 20, width: 1512, height: 949 });
  });

  it('survives a restart (same database file, new process state)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-orb-'));
    dirs.push(dir);
    const file = join(dir, 'atlas.db');
    const db = openDb(file);
    new Settings(db).setOrbPosition({ display: 1, x: 200, y: 300, width: 1512, height: 949 });
    db.close();
    expect(new Settings(openDb(file)).orbPosition()).toEqual({ display: 1, x: 200, y: 300, width: 1512, height: 949 });
  });

  it('refuses a position that is not two finite numbers', () => {
    const s = new Settings(openDb(':memory:'));
    expect(() => s.setOrbPosition({ display: 1, x: Number.NaN, y: 1, width: 10, height: 10 })).toThrow(/not an orb position/);
    expect(() => s.setOrbPosition({ display: 1, x: 1, y: 1, width: 0, height: 10 })).toThrow(/not an orb position/);
    expect(() => s.setOrbPosition({ x: 1, y: 1 } as never)).toThrow(/not an orb position/);
  });

  it('forgets a pre-#51 absolute pixel position (its display is unknown): the orb starts bottom-right again', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO settings (key, value) VALUES ('orb_position', '{\"x\":1443,\"y\":918}')").run();
    expect(new Settings(db).orbPosition()).toBeNull();
  });

  it('fails loudly on a corrupt stored value', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO settings (key, value) VALUES ('orb_position', '{\"x\":\"a\"}')").run();
    expect(() => new Settings(db).orbPosition()).toThrow(/orb_position is not a position/);
  });
});
