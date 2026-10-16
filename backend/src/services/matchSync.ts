import type { Db } from '../db/index.js';
import type { Logger, RiotClient } from '../riot/client.js';
import { getMatch, getMatchIds } from '../riot/endpoints/match.js';
import { Priority } from '../riot/rateLimiter.js';
import type { MatchDto } from '../riot/types.js';
import { validPosition } from './matchDetail.js';

export interface SyncOptions {
  /** Ne récupère que les parties commencées après cet instant (ms). */
  sinceMs: number;
  /** Nombre maximum d'IDs examinés (les plus récents d'abord). */
  maxMatches?: number;
  priority?: Priority;
}

export interface SyncResult {
  checked: number;
  added: number;
}

const PAGE_SIZE = 100; // maximum autorisé par Match-V5
const DETAIL_CONCURRENCY = 5; // le limiteur lisse de toute façon le débit

/** Récupère l'historique Match-V5 et le stocke (les 10 joueurs de chaque partie). */
export class MatchSyncService {
  /** Dernière synchro réussie, par PUUID (le compte suivi peut changer). */
  private readonly lastSync = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<SyncResult>>();
  private readonly hasStmt;
  private readonly insertMatch;
  private readonly insertParticipant;
  private readonly lastEndStmt;

  constructor(
    private readonly db: Db,
    private readonly client: RiotClient,
    private readonly region: string,
    private readonly logger: Logger,
  ) {
    this.hasStmt = db.prepare<[string], { x: number }>('SELECT 1 AS x FROM matches WHERE match_id = ?');
    this.insertMatch = db.prepare(
      `INSERT OR IGNORE INTO matches (match_id, queue_id, game_start, game_end, duration_s, game_version, raw_json)
       VALUES (@matchId, @queueId, @gameStart, @gameEnd, @durationS, @gameVersion, @raw)`,
    );
    this.insertParticipant = db.prepare(
      `INSERT OR REPLACE INTO match_participants
       (match_id, puuid, team_id, champion_id, champion_name, position, win, remake, kills, deaths, assists,
        cs, vision, gold, damage, kill_participation, champ_level, riot_id_name, riot_id_tag)
       VALUES (@matchId, @puuid, @teamId, @championId, @championName, @position, @win, @remake, @kills, @deaths,
        @assists, @cs, @vision, @gold, @damage, @killParticipation, @champLevel, @riotIdName, @riotIdTag)`,
    );
    this.lastEndStmt = db.prepare<[string], { last: number | null }>(
      `SELECT MAX(m.game_end) AS last FROM matches m JOIN match_participants p ON p.match_id = m.match_id WHERE p.puuid = ?`,
    );
  }

  /** Fin de la dernière partie connue du joueur (ms), ou null. */
  lastGameEnd(puuid: string): number | null {
    return this.lastEndStmt.get(puuid)?.last ?? null;
  }

  lastSyncAt(puuid: string): number {
    return this.lastSync.get(puuid) ?? 0;
  }

  /** Synchronise ; deux appels simultanés pour le même compte partagent la même exécution. */
  sync(puuid: string, opts: SyncOptions): Promise<SyncResult> {
    let running = this.inflight.get(puuid);
    if (!running) {
      running = this.run(puuid, opts).finally(() => this.inflight.delete(puuid));
      this.inflight.set(puuid, running);
    }
    return running;
  }

  private async run(puuid: string, opts: SyncOptions): Promise<SyncResult> {
    const priority = opts.priority ?? Priority.Session;
    const max = opts.maxMatches ?? PAGE_SIZE;
    const startTime = Math.floor(opts.sinceMs / 1000);

    const ids: string[] = [];
    for (let start = 0; ids.length < max; start += PAGE_SIZE) {
      const count = Math.min(PAGE_SIZE, max - ids.length);
      const page = await getMatchIds(this.client, this.region, puuid, { startTime, start, count }, priority);
      ids.push(...page);
      if (page.length < count) break;
    }

    const missing = ids.filter((id) => !this.hasStmt.get(id));
    let added = 0;
    for (let i = 0; i < missing.length; i += DETAIL_CONCURRENCY) {
      const chunk = missing.slice(i, i + DETAIL_CONCURRENCY);
      const dtos = await Promise.all(chunk.map((id) => getMatch(this.client, this.region, id, priority)));
      for (const dto of dtos) {
        if (dto && this.store(dto)) added++;
      }
    }

    this.lastSync.set(puuid, Date.now());
    if (added > 0) this.logger.info({ checked: ids.length, added }, 'Parties synchronisées');
    return { checked: ids.length, added };
  }

  /** Enregistre une partie et ses 10 participants. Renvoie false si elle est inexploitable. */
  store(dto: MatchDto): boolean {
    const info = dto.info;
    if (!info?.participants?.length) return false;
    const gameEnd = info.gameEndTimestamp ?? info.gameStartTimestamp + info.gameDuration * 1000;

    this.db.transaction(() => {
      this.insertMatch.run({
        matchId: dto.metadata.matchId,
        queueId: info.queueId,
        gameStart: info.gameStartTimestamp,
        gameEnd,
        durationS: info.gameDuration,
        gameVersion: info.gameVersion ?? null,
        raw: JSON.stringify(dto),
      });
      for (const p of info.participants) {
        this.insertParticipant.run({
          matchId: dto.metadata.matchId,
          puuid: p.puuid,
          teamId: p.teamId,
          championId: p.championId,
          championName: p.championName,
          // « Invalid » (rôle indéterminé par Riot) est stocké comme absent.
          position: validPosition(p.teamPosition) ?? validPosition(p.individualPosition),
          win: p.win ? 1 : 0,
          remake: p.gameEndedInEarlySurrender ? 1 : 0,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          cs: (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0),
          vision: p.visionScore ?? 0,
          gold: p.goldEarned ?? 0,
          damage: p.totalDamageDealtToChampions ?? 0,
          killParticipation: p.challenges?.killParticipation ?? null,
          champLevel: p.champLevel ?? null,
          riotIdName: p.riotIdGameName ?? null,
          riotIdTag: p.riotIdTagline ?? null,
        });
      }
    })();
    return true;
  }
}
