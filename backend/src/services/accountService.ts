import type { Db } from '../db/index.js';
import type { RiotClient } from '../riot/client.js';
import { getAccountByRiotId } from '../riot/endpoints/account.js';

export interface Account {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface RiotId {
  gameName: string;
  tagLine: string;
}

export class AccountNotFoundError extends Error {
  constructor(riotId: string) {
    super(`Compte Riot introuvable : ${riotId}`);
    this.name = 'AccountNotFoundError';
  }
}

export class InvalidRiotIdError extends Error {
  constructor(input: string) {
    super(`Riot ID invalide : « ${input} » (format attendu : Nom#TAG)`);
    this.name = 'InvalidRiotIdError';
  }
}

const RIOT_ID_RE = /^(.{3,16})#([A-Za-z0-9]{2,5})$/;
const TRACKED_KEY = 'tracked_riot_id';

export function parseRiotId(input: string): RiotId | null {
  const m = RIOT_ID_RE.exec(input.trim());
  return m ? { gameName: m[1]!.trim(), tagLine: m[2]! } : null;
}

/**
 * Compte suivi : celui choisi dans les réglages du widget (table `settings`), sinon RIOT_ID du .env.
 * Toutes les données (parties, snapshots) sont stockées par PUUID : changer de compte ne mélange rien.
 */
export class AccountService {
  private readonly upsert;
  private readonly getSetting;
  private readonly setSetting;
  private readonly delSetting;

  constructor(
    private readonly db: Db,
    private readonly client: RiotClient,
    private readonly region: string,
    private readonly defaultRiotId: RiotId,
  ) {
    this.upsert = db.prepare(
      `INSERT INTO accounts (puuid, game_name, tag_line, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(puuid) DO UPDATE SET game_name = excluded.game_name,
         tag_line = excluded.tag_line, updated_at = excluded.updated_at`,
    );
    this.getSetting = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?');
    this.setSetting = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.delSetting = db.prepare('DELETE FROM settings WHERE key = ?');
  }

  /** Riot ID actuellement suivi. */
  tracked(): RiotId & { isDefault: boolean } {
    const stored = this.getSetting.get(TRACKED_KEY)?.value;
    const parsed = stored ? parseRiotId(stored) : null;
    return parsed ? { ...parsed, isDefault: false } : { ...this.defaultRiotId, isDefault: true };
  }

  /** Compte suivi, résolu en PUUID (cache 7 j via le client). */
  me(): Promise<Account> {
    const { gameName, tagLine } = this.tracked();
    return this.resolve(gameName, tagLine);
  }

  /**
   * Change le compte suivi après avoir vérifié qu'il existe chez Riot.
   * Chaîne vide → retour au compte du .env.
   */
  async setTracked(input: string): Promise<Account> {
    if (!input.trim()) {
      this.delSetting.run(TRACKED_KEY);
      return this.me();
    }
    const riotId = parseRiotId(input);
    if (!riotId) throw new InvalidRiotIdError(input);
    const account = await this.resolve(riotId.gameName, riotId.tagLine);
    this.setSetting.run(TRACKED_KEY, `${account.gameName}#${account.tagLine}`);
    return account;
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
