import type { Db } from '../db/index.js';
import type { RiotClient } from '../riot/client.js';
import { getLeagueEntries } from '../riot/endpoints/league.js';
import { Priority } from '../riot/rateLimiter.js';
import { TRACKED_QUEUE_TYPES, type RankedQueueType } from '../domain/queues.js';
import type { RankSnapshot } from '../domain/lp.js';

export type SnapshotTrigger = 'poll' | 'session_start' | 'startup';

interface Row {
  id: number;
  tier: string;
  division: string;
  lp: number;
  wins: number;
  losses: number;
  taken_at: number;
}

/** Snapshots League-V4 : un enregistrement par changement de rang/LP/compteurs. */
export class RankSnapshotService {
  private readonly insertStmt;
  private readonly latestStmt;
  private readonly listStmt;

  constructor(
    db: Db,
    private readonly client: RiotClient,
    private readonly platform: string,
    private readonly now: () => number = Date.now,
  ) {
    this.insertStmt = db.prepare(
      `INSERT INTO rank_snapshots (puuid, queue_type, tier, division, lp, wins, losses, taken_at, trigger)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.latestStmt = db.prepare<[string, string], Row>(
      `SELECT id, tier, division, lp, wins, losses, taken_at FROM rank_snapshots
       WHERE puuid = ? AND queue_type = ? ORDER BY taken_at DESC, id DESC LIMIT 1`,
    );
    this.listStmt = db.prepare<[string, string], Row>(
      `SELECT id, tier, division, lp, wins, losses, taken_at FROM rank_snapshots
       WHERE puuid = ? AND queue_type = ? ORDER BY taken_at, id`,
    );
  }

  /**
   * Interroge League-V4 et enregistre un snapshot pour chaque file suivie dont l'état a changé
   * (ou systématiquement si `force`). Renvoie le nombre de snapshots enregistrés.
   */
  async capture(puuid: string, trigger: SnapshotTrigger, opts: { force?: boolean; priority?: Priority } = {}): Promise<number> {
    const entries = await getLeagueEntries(this.client, this.platform, puuid, opts.priority ?? Priority.Background);
    const takenAt = this.now();
    let inserted = 0;
    for (const queueType of TRACKED_QUEUE_TYPES) {
      const e = entries.find((x) => x.queueType === queueType);
      if (!e) continue; // non classé dans cette file
      const last = this.latestStmt.get(puuid, queueType);
      const changed =
        !last ||
        last.tier !== e.tier ||
        last.division !== e.rank ||
        last.lp !== e.leaguePoints ||
        last.wins !== e.wins ||
        last.losses !== e.losses;
      if (changed || opts.force) {
        this.insertStmt.run(puuid, queueType, e.tier, e.rank, e.leaguePoints, e.wins, e.losses, takenAt, trigger);
        inserted++;
      }
    }
    return inserted;
  }

  latest(puuid: string, queueType: RankedQueueType): RankSnapshot | null {
    const row = this.latestStmt.get(puuid, queueType);
    return row ? toSnapshot(row) : null;
  }

  list(puuid: string, queueType: RankedQueueType): RankSnapshot[] {
    return this.listStmt.all(puuid, queueType).map(toSnapshot);
  }
}

function toSnapshot(r: Row): RankSnapshot {
  return { id: r.id, tier: r.tier, division: r.division, lp: r.lp, wins: r.wins, losses: r.losses, takenAt: r.taken_at };
}
