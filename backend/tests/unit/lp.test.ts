import { describe, expect, it } from 'vitest';
import { attributeLp, DEFAULT_LP_ESTIMATE, type RankSnapshot, type RankedGame } from '../../src/domain/lp.js';

const MIN = 60_000;
let nextId = 1;
function snap(takenAt: number, lp: number, wins: number, losses: number, tier = 'EMERALD', division = 'II'): RankSnapshot {
  return { id: nextId++, tier, division, lp, wins, losses, takenAt };
}
function game(matchId: string, endedAt: number, win: boolean, remake = false): RankedGame {
  return { matchId, endedAt, win, remake };
}

describe('attributeLp', () => {
  it('attribue le gain exact quand une seule partie sépare deux snapshots', () => {
    const r = attributeLp([snap(0, 50, 10, 10), snap(40 * MIN, 72, 11, 10)], [game('g1', 35 * MIN, true)]);
    expect(r.perGame.get('g1')).toEqual({ lpDelta: 22, source: 'snapshot' });
  });

  it('gère une promotion de division', () => {
    const r = attributeLp(
      [snap(0, 90, 10, 10, 'EMERALD', 'II'), snap(40 * MIN, 12, 11, 10, 'EMERALD', 'I')],
      [game('g1', 35 * MIN, true)],
    );
    expect(r.perGame.get('g1')?.lpDelta).toBe(22);
  });

  it('répartit le total exact entre plusieurs parties (estimation)', () => {
    const r = attributeLp(
      [snap(0, 50, 10, 10), snap(40 * MIN, 72, 11, 10), snap(120 * MIN, 35, 11, 12)],
      [game('g1', 35 * MIN, true), game('g2', 80 * MIN, false), game('g3', 115 * MIN, false)],
    );
    const g2 = r.perGame.get('g2')!;
    const g3 = r.perGame.get('g3')!;
    expect(g2.source).toBe('estimated');
    expect(g3.source).toBe('estimated');
    expect(g2.lpDelta! + g3.lpDelta!).toBe(-37); // le total reste exact
    expect(g2.lpDelta).toBeLessThan(0);
  });

  it('APPROXIMATIF avant le premier snapshot : médiane des gains exacts connus', () => {
    const r = attributeLp(
      [snap(100 * MIN, 50, 10, 10), snap(140 * MIN, 74, 11, 10)],
      [game('old-win', 10 * MIN, true), game('old-loss', 20 * MIN, false), game('g1', 135 * MIN, true)],
    );
    expect(r.perGame.get('g1')).toEqual({ lpDelta: 24, source: 'snapshot' });
    expect(r.perGame.get('old-win')).toEqual({ lpDelta: 24, source: 'estimated' });
    // aucune perte exacte connue → valeur de repli
    expect(r.perGame.get('old-loss')).toEqual({ lpDelta: -DEFAULT_LP_ESTIMATE, source: 'estimated' });
  });

  it('détecte une esquive (LP perdus sans partie jouée)', () => {
    const r = attributeLp([snap(0, 50, 10, 10), snap(10 * MIN, 45, 10, 10)], []);
    expect(r.adjustments).toEqual([{ at: 10 * MIN, delta: -5 }]);
  });

  it('ne compte pas les remakes', () => {
    const r = attributeLp(
      [snap(0, 50, 10, 10), snap(60 * MIN, 72, 11, 10)],
      [game('remake', 10 * MIN, false, true), game('g1', 50 * MIN, true)],
    );
    expect(r.perGame.get('remake')).toEqual({ lpDelta: 0, source: 'estimated' });
    expect(r.perGame.get('g1')).toEqual({ lpDelta: 22, source: 'snapshot' });
  });

  it('attend la synchro si la partie n’est pas encore dans Match-V5', () => {
    const r = attributeLp([snap(0, 50, 10, 10), snap(40 * MIN, 72, 11, 10)], []);
    expect(r.perGame.size).toBe(0);
    expect(r.adjustments).toEqual([]);
  });

  it('partie finie juste avant le snapshot A mais déjà comptée dedans : prend la plus récente', () => {
    // g0 finit 1 min avant A et A la compte déjà (wins=11) ; seule g1 sépare A et B.
    const r = attributeLp(
      [snap(0, 72, 11, 10), snap(40 * MIN, 52, 11, 11)],
      [game('g0', -1 * MIN, true), game('g1', 35 * MIN, false)],
    );
    expect(r.perGame.get('g1')).toEqual({ lpDelta: -20, source: 'snapshot' });
    expect(r.perGame.get('g0')?.source).toBe('estimated');
  });
});
