import type { Db } from '../db/index.js';
import type { Logger } from '../riot/client.js';
import { Priority } from '../riot/rateLimiter.js';
import { attributeLp, type GameLp, type LpSource, type RankSnapshot } from '../domain/lp.js';
import { startOfDay, startOfWeek, type Period } from '../domain/periods.js';
import {
  QUEUE_TYPE_BY_MODE,
  RANKED_QUEUE_TYPE,
  queueLabel,
  queuesForMode,
  type Mode,
  type RankedQueueType,
} from '../domain/queues.js';
import { absoluteLp, rankLabel } from '../domain/rank.js';
import { computeStreaks, type Result } from '../domain/streaks.js';
import type { AccountService } from './accountService.js';
import type { MatchSyncService } from './matchSync.js';
import type { RankSnapshotService } from './rankSnapshots.js';

/** Au-delà, une requête de session relance une synchro Riot avant de répondre. */
const FRESH_MS = 60_000;
/** Temps maximum d'attente de la synchro avant de répondre avec les données stockées. */
const FRESHEN_TIMEOUT_MS = 5_000;
/** Profondeur de l'historique récupéré au premier lancement. */
export const BACKFILL_MS = 14 * 24 * 3600_000;

export interface Session {
  id: number;
  startedAt: string;
  endedAt: string | null;
}

export interface MatchLine {
  matchId: string;
  queueId: number;
  queue: string;
  endedAt: string;
  durationS: number;
  champion: { id: number; name: string };
  position: string | null;
  result: Result | 'REMAKE';
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  cs: number;
  csPerMin: number;
  vision: number;
  damage: number;
  gold: number;
  killParticipation: number | null;
  champLevel: number | null;
  lpDelta: number | null;
  /** « estimated » = approximatif (cf. domain/lp.ts) ; null hors file classée. */
  lpSource: LpSource | null;
}

export interface RankInfo {
  queueType: RankedQueueType;
  label: string;
  tier: string;
  division: string;
  lp: number;
  wins: number;
  losses: number;
  winrate: number | null;
  /** Rang au début de la période (snapshot le plus proche), pour afficher la progression. */
  atPeriodStart: { label: string; lp: number } | null;
}

export interface SessionSummary {
  mode: Mode;
  period: Period;
  from: string | null;
  to: string;
  session: Session | null;
  summary: {
    games: number;
    wins: number;
    losses: number;
    remakes: number;
    winrate: number | null;
    timePlayedS: number;
    kills: number;
    deaths: number;
    assists: number;
    kda: number | null;
    csPerMin: number | null;
    avgVision: number | null;
    avgKillParticipation: number | null;
  };
  lp: { net: number; source: LpSource; adjustments: number } | null;
  rank: RankInfo | null;
  streak: {
    /** Série en cours sur tout l'historique du mode (pas seulement la période). */
    current: { result: Result; count: number } | null;
    longestWinInPeriod: number;
    longestLossInPeriod: number;
    /** Résultats de la période, du plus ancien au plus récent, ex. « WWLWL ». */
    sequence: string;
  };
  /** Parties de la période, la plus récente d'abord. */
  matches: MatchLine[];
}

interface GameRow {
  match_id: string;
  queue_id: number;
  game_end: number;
  duration_s: number;
  champion_id: number;
  champion_name: string;
  position: string | null;
  win: number;
  remake: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  vision: number;
  gold: number;
  damage: number;
  kill_participation: number | null;
  champ_level: number | null;
}

interface SessionRow {
  id: number;
  started_at: number;
  ended_at: number | null;
}

export interface SessionServiceDeps {
  db: Db;
  accounts: AccountService;
  matches: MatchSyncService;
  ranks: RankSnapshotService;
  riotId: { gameName: string; tagLine: string };
  logger: Logger;
  now?: () => number;
}

export class SessionService {
  private readonly now: () => number;
  private readonly activeStmt;
  private readonly insertStmt;
  private readonly closeStmt;
  private readonly byIdStmt;
  private readonly gamesStmt;

  constructor(private readonly deps: SessionServiceDeps) {
    this.now = deps.now ?? Date.now;
    const db = deps.db;
    this.activeStmt = db.prepare<[], SessionRow>(
      'SELECT id, started_at, ended_at FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    );
    this.insertStmt = db.prepare<[number], SessionRow>(
      'INSERT INTO sessions (started_at) VALUES (?) RETURNING id, started_at, ended_at',
    );
    this.closeStmt = db.prepare('UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL');
    this.byIdStmt = db.prepare<[number], SessionRow>('SELECT id, started_at, ended_at FROM sessions WHERE id = ?');
    this.gamesStmt = db.prepare<[string], GameRow>(
      `SELECT m.match_id, m.queue_id, m.game_end, m.duration_s, p.champion_id, p.champion_name, p.position, p.win,
              p.remake, p.kills, p.deaths, p.assists, p.cs, p.vision, p.gold, p.damage, p.kill_participation, p.champ_level
       FROM match_participants p JOIN matches m ON m.match_id = p.match_id
       WHERE p.puuid = ? ORDER BY m.game_end`,
    );
  }

  active(): Session | null {
    const row = this.activeStmt.get();
    return row ? toSession(row) : null;
  }

  /** Démarre une session (ferme la précédente) et prend un snapshot de rang de référence. */
  async start(): Promise<Session> {
    const now = this.now();
    const row = this.deps.db.transaction(() => {
      this.closeStmt.run(now);
      return this.insertStmt.get(now)!;
    })();
    try {
      const { puuid } = await this.deps.accounts.me(this.deps.riotId);
      await this.deps.ranks.capture(puuid, 'session_start', { force: true, priority: Priority.Session });
    } catch (err) {
      this.deps.logger.warn({ err: String(err) }, 'Snapshot de début de session impossible');
    }
    return toSession(row);
  }

  stop(): Session | null {
    const active = this.activeStmt.get();
    if (!active) return null;
    this.closeStmt.run(this.now());
    return toSession(this.byIdStmt.get(active.id)!);
  }

  /** Relance une synchro si les données ont plus de FRESH_MS, sans bloquer plus de FRESHEN_TIMEOUT_MS. */
  private async freshen(puuid: string): Promise<void> {
    const now = this.now();
    if (now - this.deps.matches.lastSyncAt < FRESH_MS) return;
    const lastEnd = this.deps.matches.lastGameEnd(puuid);
    const sinceMs = lastEnd ? Math.max(lastEnd - 3600_000, now - BACKFILL_MS) : now - BACKFILL_MS;
    const work = Promise.all([
      this.deps.matches.sync(puuid, { sinceMs, priority: Priority.Session }),
      this.deps.ranks.capture(puuid, 'poll', { priority: Priority.Session }),
    ]);
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), FRESHEN_TIMEOUT_MS).unref?.());
    try {
      const res = await Promise.race([work, timeout]);
      if (res === 'timeout') this.deps.logger.info({}, 'Synchro encore en cours : réponse avec les données stockées');
    } catch (err) {
      this.deps.logger.warn({ err: String(err) }, 'Synchro impossible : réponse avec les données stockées');
    }
  }

  async summary(mode: Mode, period: Period): Promise<SessionSummary> {
    const { puuid } = await this.deps.accounts.me(this.deps.riotId);
    await this.freshen(puuid);

    const now = this.now();
    const session = this.active();
    let from: number | null;
    if (period === 'session') from = session ? Date.parse(session.startedAt) : null;
    else if (period === 'jour') from = startOfDay(now);
    else from = startOfWeek(now);

    const queues = queuesForMode(mode);
    const allGames = this.gamesStmt.all(puuid).filter((g) => !queues || queues.includes(g.queue_id));

    // LP : attribution par file classée, sur tout l'historique stocké (plus de contexte = meilleures estimations).
    const lpByMatch = new Map<string, GameLp>();
    const snapshotsByQueue = new Map<RankedQueueType, RankSnapshot[]>();
    let adjustmentsInPeriod = 0;
    for (const queueType of ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'] as const) {
      const queueGames = allGames.filter((g) => RANKED_QUEUE_TYPE[g.queue_id] === queueType);
      const snapshots = this.deps.ranks.list(puuid, queueType);
      snapshotsByQueue.set(queueType, snapshots);
      const attribution = attributeLp(
        snapshots,
        queueGames.map((g) => ({ matchId: g.match_id, endedAt: g.game_end, win: g.win === 1, remake: g.remake === 1 })),
      );
      for (const [id, v] of attribution.perGame) lpByMatch.set(id, v);
      if (QUEUE_TYPE_BY_MODE[mode] === queueType) {
        adjustmentsInPeriod = attribution.adjustments
          .filter((a) => from !== null && a.at >= from && a.at <= now)
          .reduce((s, a) => s + a.delta, 0);
      }
    }

    const inPeriod = from === null ? [] : allGames.filter((g) => g.game_end >= from && g.game_end <= now);
    const played = inPeriod.filter((g) => g.remake === 0);
    const wins = played.filter((g) => g.win === 1).length;
    const totals = played.reduce(
      (t, g) => ({
        kills: t.kills + g.kills,
        deaths: t.deaths + g.deaths,
        assists: t.assists + g.assists,
        cs: t.cs + g.cs,
        minutes: t.minutes + g.duration_s / 60,
        vision: t.vision + g.vision,
      }),
      { kills: 0, deaths: 0, assists: 0, cs: 0, minutes: 0, vision: 0 },
    );
    const kps = played.map((g) => g.kill_participation).filter((v): v is number => v !== null);

    const periodResults = played.map((g): Result => (g.win === 1 ? 'W' : 'L'));
    const historyResults = allGames.filter((g) => g.remake === 0).map((g): Result => (g.win === 1 ? 'W' : 'L'));
    const periodStreaks = computeStreaks(periodResults);

    // LP net de la période = somme des gains par partie + ajustements (esquives, decay).
    const rankedQueueType = QUEUE_TYPE_BY_MODE[mode];
    let lp: SessionSummary['lp'] = null;
    if (rankedQueueType) {
      const lines = inPeriod.map((g) => lpByMatch.get(g.match_id)).filter((v): v is GameLp => !!v);
      lp = {
        net: lines.reduce((s, v) => s + (v.lpDelta ?? 0), 0) + adjustmentsInPeriod,
        source: lines.every((v) => v.source === 'snapshot' || v.lpDelta === 0) ? 'snapshot' : 'estimated',
        adjustments: adjustmentsInPeriod,
      };
    }

    return {
      mode,
      period,
      from: from === null ? null : new Date(from).toISOString(),
      to: new Date(now).toISOString(),
      session,
      summary: {
        games: played.length,
        wins,
        losses: played.length - wins,
        remakes: inPeriod.length - played.length,
        winrate: played.length ? round(wins / played.length, 3) : null,
        timePlayedS: inPeriod.reduce((s, g) => s + g.duration_s, 0),
        kills: totals.kills,
        deaths: totals.deaths,
        assists: totals.assists,
        kda: played.length ? round((totals.kills + totals.assists) / Math.max(1, totals.deaths), 2) : null,
        csPerMin: totals.minutes ? round(totals.cs / totals.minutes, 1) : null,
        avgVision: played.length ? round(totals.vision / played.length, 1) : null,
        avgKillParticipation: kps.length ? round(kps.reduce((s, v) => s + v, 0) / kps.length, 3) : null,
      },
      lp,
      rank: rankedQueueType ? this.rankInfo(puuid, rankedQueueType, snapshotsByQueue.get(rankedQueueType) ?? [], from) : null,
      streak: {
        current: computeStreaks(historyResults).current,
        longestWinInPeriod: periodStreaks.longestWin,
        longestLossInPeriod: periodStreaks.longestLoss,
        sequence: periodResults.join(''),
      },
      matches: inPeriod
        .slice()
        .reverse()
        .map((g) => toMatchLine(g, lpByMatch.get(g.match_id) ?? null)),
    };
  }

  private rankInfo(puuid: string, queueType: RankedQueueType, snapshots: RankSnapshot[], from: number | null): RankInfo | null {
    const cur = this.deps.ranks.latest(puuid, queueType);
    if (!cur) return null;
    let start: RankSnapshot | undefined;
    if (from !== null) {
      start = [...snapshots].reverse().find((s) => s.takenAt <= from) ?? snapshots.find((s) => s.takenAt >= from);
    }
    const total = cur.wins + cur.losses;
    return {
      queueType,
      label: rankLabel(cur.tier, cur.division),
      tier: cur.tier,
      division: cur.division,
      lp: cur.lp,
      wins: cur.wins,
      losses: cur.losses,
      winrate: total ? round(cur.wins / total, 3) : null,
      atPeriodStart:
        start && absoluteLp(start.tier, start.division, start.lp) !== null
          ? { label: rankLabel(start.tier, start.division), lp: start.lp }
          : null,
    };
  }
}

function toMatchLine(g: GameRow, lp: GameLp | null): MatchLine {
  const minutes = g.duration_s / 60;
  const ranked = RANKED_QUEUE_TYPE[g.queue_id] !== undefined;
  return {
    matchId: g.match_id,
    queueId: g.queue_id,
    queue: queueLabel(g.queue_id),
    endedAt: new Date(g.game_end).toISOString(),
    durationS: g.duration_s,
    champion: { id: g.champion_id, name: g.champion_name },
    position: g.position,
    result: g.remake ? 'REMAKE' : g.win ? 'W' : 'L',
    kills: g.kills,
    deaths: g.deaths,
    assists: g.assists,
    kda: round((g.kills + g.assists) / Math.max(1, g.deaths), 2),
    cs: g.cs,
    csPerMin: minutes ? round(g.cs / minutes, 1) : 0,
    vision: g.vision,
    damage: g.damage,
    gold: g.gold,
    killParticipation: g.kill_participation === null ? null : round(g.kill_participation, 3),
    champLevel: g.champ_level,
    lpDelta: ranked ? (lp?.lpDelta ?? null) : null,
    lpSource: ranked ? (lp?.source ?? null) : null,
  };
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: r.ended_at === null ? null : new Date(r.ended_at).toISOString(),
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
