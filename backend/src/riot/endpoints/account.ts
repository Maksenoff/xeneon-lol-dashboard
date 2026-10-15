import { Priority } from '../rateLimiter.js';
import type { RiotClient } from '../client.js';

/** AccountDto — Account-V1 (doc officielle : puuid, gameName, tagLine). */
export interface AccountDto {
  puuid: string;
  gameName?: string;
  tagLine?: string;
}

const WEEK_MS = 7 * 24 * 3600_000;

/** GET /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine} (routage régional). */
export function getAccountByRiotId(
  client: RiotClient,
  region: string,
  gameName: string,
  tagLine: string,
  priority: Priority = Priority.Session,
): Promise<AccountDto | null> {
  return client.get<AccountDto>({
    host: region,
    path: `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    methodKey: 'account-v1:by-riot-id',
    ttlMs: WEEK_MS,
    priority,
    notFoundAsNull: true,
  });
}
