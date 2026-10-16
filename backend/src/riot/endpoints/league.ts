import { Priority } from '../rateLimiter.js';
import type { RiotClient } from '../client.js';
import type { LeagueEntryDto } from '../types.js';

/**
 * GET /lol/league/v4/entries/by-puuid/{puuid} (routage plateforme).
 * Par défaut jamais mis en cache : pour le compte suivi, chaque appel sert de snapshot de LP.
 * Pour les autres joueurs (partie en cours), un cache de quelques minutes suffit.
 */
export async function getLeagueEntries(
  client: RiotClient,
  platform: string,
  puuid: string,
  priority: Priority = Priority.Background,
  ttlMs = 0,
): Promise<LeagueEntryDto[]> {
  const entries = await client.get<LeagueEntryDto[]>({
    host: platform,
    path: `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
    methodKey: 'league-v4:entries-by-puuid',
    ttlMs,
    priority,
  });
  return entries ?? [];
}
