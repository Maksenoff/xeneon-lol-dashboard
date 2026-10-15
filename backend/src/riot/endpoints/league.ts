import { Priority } from '../rateLimiter.js';
import type { RiotClient } from '../client.js';
import type { LeagueEntryDto } from '../types.js';

/**
 * GET /lol/league/v4/entries/by-puuid/{puuid} (routage plateforme).
 * Jamais mis en cache : chaque appel sert de snapshot de LP.
 */
export async function getLeagueEntries(
  client: RiotClient,
  platform: string,
  puuid: string,
  priority: Priority = Priority.Background,
): Promise<LeagueEntryDto[]> {
  const entries = await client.get<LeagueEntryDto[]>({
    host: platform,
    path: `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
    methodKey: 'league-v4:entries-by-puuid',
    ttlMs: 0,
    priority,
  });
  return entries ?? [];
}
