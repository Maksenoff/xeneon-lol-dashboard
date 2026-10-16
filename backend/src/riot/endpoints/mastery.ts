import { Priority } from '../rateLimiter.js';
import type { RiotClient } from '../client.js';

/** ChampionMasteryDto (champs vérifiés sur une vraie réponse EUW). */
export interface ChampionMasteryDto {
  championId: number;
  championLevel: number;
  championPoints: number;
  lastPlayTime: number; // ms epoch
}

/**
 * GET /lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}/by-champion/{championId}
 * null (404) si le joueur n'a jamais joué ce champion.
 */
export function getMasteryByChampion(
  client: RiotClient,
  platform: string,
  puuid: string,
  championId: number,
  priority: Priority = Priority.Live,
): Promise<ChampionMasteryDto | null> {
  return client.get<ChampionMasteryDto>({
    host: platform,
    path: `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}/by-champion/${championId}`,
    methodKey: 'champion-mastery-v4:by-champion',
    ttlMs: 3600_000,
    priority,
    notFoundAsNull: true,
  });
}
