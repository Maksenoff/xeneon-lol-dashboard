/**
 * Sous-ensembles des DTO Riot réellement utilisés.
 * Champs vérifiés sur de vraies réponses EUW (patch 16.20, octobre 2026).
 */

export interface ParticipantDto {
  puuid: string;
  teamId: number;
  championId: number;
  championName: string;
  teamPosition?: string;
  individualPosition?: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  visionScore: number;
  goldEarned: number;
  totalDamageDealtToChampions: number;
  champLevel?: number;
  gameEndedInEarlySurrender?: boolean;
  riotIdGameName?: string;
  riotIdTagline?: string;
  challenges?: { killParticipation?: number; soloKills?: number; epicMonsterSteals?: number };
}

export interface MatchDto {
  metadata: { matchId: string; participants: string[] };
  info: {
    queueId: number;
    gameCreation: number;
    gameStartTimestamp: number;
    gameEndTimestamp?: number; // absent sur les très vieilles parties
    gameDuration: number; // secondes (depuis le patch 11.20)
    gameVersion?: string;
    endOfGameResult?: string;
    participants: ParticipantDto[];
  };
}

/** League-V4 entries/by-puuid. */
export interface LeagueEntryDto {
  queueType: string; // RANKED_SOLO_5x5 | RANKED_FLEX_SR | RANKED_PREMADE_5x5…
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak?: boolean;
  veteran?: boolean;
  freshBlood?: boolean;
}
