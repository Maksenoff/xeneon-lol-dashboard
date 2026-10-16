import { Priority } from '../rateLimiter.js';
import type { RiotClient } from '../client.js';

/**
 * CurrentGameInfo — Spectator-V5, d'après la documentation officielle Riot.
 * ⚠ Format NON vérifié sur une vraie réponse : `featured-games` est refusé (403) aux clés de
 * développement, et le compte n'était pas en partie pendant le développement. La première vraie
 * réponse est enregistrée dans <DATA_DIR>/debug/spectator-last.json pour contrôle.
 */
export interface CurrentGameParticipant {
  puuid?: string | null; // absent/vide si le joueur est masqué
  riotId?: string; // « Nom#TAG »
  championId: number;
  teamId: number; // 100 = bleu, 200 = rouge
  spell1Id?: number;
  spell2Id?: number;
  bot?: boolean;
  profileIconId?: number;
}

export interface CurrentGameInfo {
  gameId: number;
  gameQueueConfigId?: number;
  gameMode?: string;
  gameType?: string;
  gameStartTime?: number; // ms epoch (0 pendant le chargement)
  gameLength?: number; // secondes
  platformId?: string;
  participants: CurrentGameParticipant[];
  bannedChampions?: Array<{ championId: number; teamId: number; pickTurn: number }>;
}

/** GET /lol/spectator/v5/active-games/by-summoner/{puuid} — null si le joueur n'est pas en partie (404). */
export function getActiveGame(
  client: RiotClient,
  platform: string,
  puuid: string,
  priority: Priority = Priority.Live,
): Promise<CurrentGameInfo | null> {
  return client.get<CurrentGameInfo>({
    host: platform,
    path: `/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`,
    methodKey: 'spectator-v5:active-game',
    ttlMs: 15_000,
    priority,
    notFoundAsNull: true,
  });
}
