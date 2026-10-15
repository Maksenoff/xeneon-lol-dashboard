import type { Db } from '../db/index.js';
import type { RiotClient } from '../riot/client.js';
import { getAccountByRiotId } from '../riot/endpoints/account.js';

export interface Account {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export class AccountNotFoundError extends Error {
  constructor(riotId: string) {
    super(`Compte Riot introuvable : ${riotId}`);
    this.name = 'AccountNotFoundError';
  }
}

export class AccountService {
  private readonly upsert;

  constructor(
    private readonly db: Db,
    private readonly client: RiotClient,
    private readonly region: string,
  ) {
    this.upsert = db.prepare(
      `INSERT INTO accounts (puuid, game_name, tag_line, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(puuid) DO UPDATE SET game_name = excluded.game_name,
         tag_line = excluded.tag_line, updated_at = excluded.updated_at`,
    );
  }

  /** Compte suivi (RIOT_ID du .env). */
  me(riotId: { gameName: string; tagLine: string }): Promise<Account> {
    return this.resolve(riotId.gameName, riotId.tagLine);
  }

  /** Résout un Riot ID en PUUID (cache 7 j via le client) et le mémorise en base. */
  async resolve(gameName: string, tagLine: string): Promise<Account> {
    const dto = await getAccountByRiotId(this.client, this.region, gameName, tagLine);
    if (!dto) throw new AccountNotFoundError(`${gameName}#${tagLine}`);
    const account: Account = {
      puuid: dto.puuid,
      gameName: dto.gameName ?? gameName,
      tagLine: dto.tagLine ?? tagLine,
    };
    this.upsert.run(account.puuid, account.gameName, account.tagLine, Date.now());
    return account;
  }
}
