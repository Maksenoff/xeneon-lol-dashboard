import { describe, expect, it } from 'vitest';
import { absoluteLp, rankLabel } from '../../src/domain/rank.js';
import { startOfDay, startOfWeek } from '../../src/domain/periods.js';
import { computeStreaks } from '../../src/domain/streaks.js';
import { queuesForMode, queueLabel } from '../../src/domain/queues.js';
import { formatPoints } from '../../src/services/liveService.js';

describe('formatPoints', () => {
  it('affiche M au-delà du million, k au-delà de mille', () => {
    expect(formatPoints(1_919_463)).toBe('1,9 M');
    expect(formatPoints(950_000)).toBe('950 k');
    expect(formatPoints(850)).toBe('850');
  });
});

describe('absoluteLp', () => {
  it('ordonne les rangs sur une échelle continue', () => {
    expect(absoluteLp('IRON', 'IV', 0)).toBe(0);
    expect(absoluteLp('EMERALD', 'II', 80)).toBe(5 * 400 + 2 * 100 + 80);
    expect(absoluteLp('emerald', 'ii', 80)).toBe(2280);
  });
  it('donne le bon écart à travers une promotion et une relégation', () => {
    expect(absoluteLp('EMERALD', 'I', 10)! - absoluteLp('EMERALD', 'II', 85)!).toBe(25);
    expect(absoluteLp('PLATINUM', 'I', 80)! - absoluteLp('EMERALD', 'IV', 0)!).toBe(-20);
    expect(absoluteLp('MASTER', 'I', 19)! - absoluteLp('DIAMOND', 'I', 99)!).toBe(20);
    expect(absoluteLp('GRANDMASTER', 'I', 500)).toBe(absoluteLp('MASTER', 'I', 500));
  });
  it('renvoie null pour un rang inconnu', () => {
    expect(absoluteLp('UNRANKED', 'I', 0)).toBeNull();
  });
  it('produit un libellé français', () => {
    expect(rankLabel('EMERALD', 'II')).toBe('Émeraude II');
    expect(rankLabel('MASTER', 'I')).toBe('Maître');
  });
});

describe('périodes (Europe/Paris)', () => {
  // Jeudi 15 octobre 2026, 20:00 heure de Paris (UTC+2)
  const thursday = Date.parse('2026-10-15T18:00:00Z');

  it('jour = minuit local', () => {
    expect(new Date(startOfDay(thursday)).toISOString()).toBe('2026-10-14T22:00:00.000Z');
  });
  it('semaine = lundi 00:00 local', () => {
    expect(new Date(startOfWeek(thursday)).toISOString()).toBe('2026-10-11T22:00:00.000Z');
  });
  it('gère le passage à l’heure d’hiver (25/10/2026)', () => {
    const sunday = Date.parse('2026-10-25T12:00:00Z');
    expect(new Date(startOfWeek(sunday)).toISOString()).toBe('2026-10-18T22:00:00.000Z'); // lundi 19, UTC+2
    const monday = Date.parse('2026-10-26T12:00:00Z');
    expect(new Date(startOfWeek(monday)).toISOString()).toBe('2026-10-25T23:00:00.000Z'); // lundi 26, UTC+1
  });
});

describe('computeStreaks', () => {
  it('calcule la série en cours et les plus longues séries', () => {
    expect(computeStreaks(['W', 'W', 'L', 'W', 'W', 'W', 'L', 'L'])).toEqual({
      current: { result: 'L', count: 2 },
      longestWin: 3,
      longestLoss: 2,
    });
  });
  it('gère une liste vide', () => {
    expect(computeStreaks([])).toEqual({ current: null, longestWin: 0, longestLoss: 0 });
  });
});

describe('files', () => {
  it('regroupe les files par mode', () => {
    expect(queuesForMode('rsolo')).toEqual([420]);
    expect(queuesForMode('normal')).toEqual([400, 430, 480, 490]);
    expect(queuesForMode('all')).toBeNull();
    expect(queueLabel(450)).toBe('ARAM');
    expect(queueLabel(9999)).toBe('File 9999');
  });
});

import { fillMissingPositions, validPosition } from '../../src/services/matchDetail.js';

describe('rôles « Invalid » renvoyés par Riot', () => {
  it('ignore les valeurs inconnues', () => {
    expect(validPosition('Invalid')).toBeNull();
    expect(validPosition('')).toBeNull();
    expect(validPosition('BOTTOM')).toBe('BOTTOM');
  });

  it('complète par élimination le seul rôle libre (cas réel : Vladimir « Invalid » → BOTTOM)', () => {
    const team = ['TOP', 'JUNGLE', 'MIDDLE', 'UTILITY', null].map((position) => ({ teamId: 200, position }));
    fillMissingPositions(team);
    expect(team.map((p) => p.position)).toEqual(['TOP', 'JUNGLE', 'MIDDLE', 'UTILITY', 'BOTTOM']);
  });

  it('ne devine rien si le compte ne tombe pas juste', () => {
    const team = ['TOP', 'TOP', 'MIDDLE', null, null].map((position) => ({ teamId: 100, position }));
    fillMissingPositions(team);
    expect(team.map((p) => p.position)).toEqual(['TOP', 'TOP', 'MIDDLE', null, null]);
  });
});
