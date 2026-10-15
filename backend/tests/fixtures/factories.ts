import type { LeagueEntryDto, MatchDto, ParticipantDto } from '../../src/riot/types.js';

/**
 * Fabriques de réponses Riot simulées. Structure calquée sur de vraies réponses Match-V5 /
 * League-V4 (EUW, patch 16.20) ; seuls les champs utilisés par le backend sont remplis.
 */

export const ME = 'FAKE-PUUID-MAKSENOFF';

export interface MatchSpec {
  id: string;
  endedAt: number;
  win: boolean;
  queueId?: number;
  durationS?: number;
  remake?: boolean;
  champion?: string;
  championId?: number;
  k?: number;
  d?: number;
  a?: number;
}

function participant(puuid: string, teamId: number, win: boolean, remake: boolean, extra: Partial<ParticipantDto> = {}): ParticipantDto {
  return {
    puuid,
    teamId,
    championId: 1,
    championName: 'Annie',
    teamPosition: 'MIDDLE',
    individualPosition: 'MIDDLE',
    win,
    kills: 3,
    deaths: 3,
    assists: 3,
    totalMinionsKilled: 150,
    neutralMinionsKilled: 10,
    visionScore: 20,
    goldEarned: 10000,
    totalDamageDealtToChampions: 15000,
    champLevel: 15,
    gameEndedInEarlySurrender: remake,
    riotIdGameName: puuid,
    riotIdTagline: 'EUW',
    challenges: { killParticipation: 0.5 },
    ...extra,
  };
}

export function makeMatch(s: MatchSpec): MatchDto {
  const durationS = s.durationS ?? (s.remake ? 200 : 1800);
  const remake = s.remake ?? false;
  const me = participant(ME, 100, s.win, remake, {
    championName: s.champion ?? 'Vayne',
    championId: s.championId ?? 67,
    teamPosition: 'BOTTOM',
    kills: s.k ?? 10,
    deaths: s.d ?? 5,
    assists: s.a ?? 8,
  });
  const others = Array.from({ length: 9 }, (_, i) =>
    participant(`OTHER-${s.id}-${i}`, i < 4 ? 100 : 200, i < 4 ? s.win : !s.win, remake),
  );
  return {
    metadata: { matchId: s.id, participants: [ME, ...others.map((o) => o.puuid)] },
    info: {
      queueId: s.queueId ?? 420,
      gameCreation: s.endedAt - durationS * 1000 - 60_000,
      gameStartTimestamp: s.endedAt - durationS * 1000,
      gameEndTimestamp: s.endedAt,
      gameDuration: durationS,
      gameVersion: '16.20.824.8524',
      endOfGameResult: 'GameComplete',
      participants: [me, ...others],
    },
  };
}

export function leagueEntry(queueType: string, tier: string, rank: string, lp: number, wins: number, losses: number): LeagueEntryDto {
  return { queueType, tier, rank, leaguePoints: lp, wins, losses, hotStreak: false };
}
