import { Priority } from '../rateLimiter.js';
import type { RiotClient } from '../client.js';
import type { MatchDto } from '../types.js';

export interface MatchIdsQuery {
  startTime?: number; // secondes epoch
  endTime?: number; // secondes epoch
  queue?: number;
  start?: number;
  count?: number; // 0..100
}

/** GET /lol/match/v5/matches/by-puuid/{puuid}/ids (routage régional). Plus récent en premier. */
export async function getMatchIds(
  client: RiotClient,
  region: string,
  puuid: string,
  query: MatchIdsQuery,
  priority: Priority = Priority.Session,
): Promise<string[]> {
  const ids = await client.get<string[]>({
    host: region,
    path: `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids`,
    query: { ...query },
    methodKey: 'match-v5:ids',
    ttlMs: 30_000,
    priority,
  });
  return ids ?? [];
}

/**
 * GET /lol/match/v5/matches/{matchId}. Pas de cache HTTP : la partie est stockée
 * dans la table `matches`, ce qui évite de la garder deux fois.
 */
export function getMatch(
  client: RiotClient,
  region: string,
  matchId: string,
  priority: Priority = Priority.Session,
): Promise<MatchDto | null> {
  return client.get<MatchDto>({
    host: region,
    path: `/lol/match/v5/matches/${encodeURIComponent(matchId)}`,
    methodKey: 'match-v5:match',
    ttlMs: 0,
    priority,
    notFoundAsNull: true,
  });
}
