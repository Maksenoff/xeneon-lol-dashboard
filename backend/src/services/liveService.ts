import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/index.js';
import type { Logger, RiotClient } from '../riot/client.js';
import { Priority } from '../riot/rateLimiter.js';
import { getActiveGame, type CurrentGameInfo, type CurrentGameParticipant } from '../riot/endpoints/spectator.js';
import { getLeagueEntries } from '../riot/endpoints/league.js';
import { getMasteryByChampion, type ChampionMasteryDto } from '../riot/endpoints/mastery.js';
import { getMatch, getMatchIds } from '../riot/endpoints/match.js';
import type { LeagueEntryDto } from '../riot/types.js';
import type { LiveClient, LiveAllGameData, LivePlayer } from '../liveclient/liveClient.js';
import type { DataDragon } from '../ddragon/ddragon.js';
import { RANKED_QUEUE_TYPE, queueLabel, type RankedQueueType } from '../domain/queues.js';
import { absoluteLp, emblemPath, rankFromAbsolute, rankLabel } from '../domain/rank.js';
import { computeStreaks, type Result } from '../domain/streaks.js';
import type { AccountService } from './accountService.js';
import type { MatchSyncService } from './matchSync.js';

/**
 * Partie en cours (façon Porofessor) : Spectator-V5 donne les 10 joueurs, puis chaque joueur est
 * enrichi en tâche de fond — rang (League-V4), maîtrise du champion, N dernières parties (Match-V5).
 *
 * Budget : ~2 + 1 + N requêtes par joueur → ~230 pour N = 20, soit 4 à 5 minutes avec une clé
 * de développement (100 req / 2 min). D'où un chargement PROGRESSIF : rang et maîtrise d'abord
 * (quelques secondes), puis les 5 dernières parties de chacun, puis le reste. La réponse indique
 * `status: 'partial'` et la progression tant que tout n'est pas chargé.
 *
 * Conditions d'utilisation : on n'affiche que des données publiques des joueurs d'une partie
 * DÉJÀ lancée (comme Porofessor) ; rien pendant la sélection des champions, aucun minuteur
 * de sorts ou d'objectifs.
 */

export const RECENT_GAMES = 20;
const FIRST_WAVE = 5;
const LEAGUE_TTL_MS = 10 * 60_000;

type Tone = 'strong' | 'weak' | 'info';

export interface LivePlayerView {
  puuid: string | null;
  riotId: string;
  gameName: string;
  isMe: boolean;
  bot: boolean;
  champion: { id: number; name: string; icon: string };
  rank: {
    queueType: RankedQueueType;
    label: string;
    tier: string;
    division: string;
    lp: number;
    wins: number;
    losses: number;
    winrate: number | null;
    hotStreak: boolean;
    emblem: string;
  } | null;
  mastery: { level: number; points: number; lastPlayed: string | null } | null;
  recent: {
    /** Parties analysées (hors remakes) parmi les N dernières. */
    games: number;
    wins: number;
    winrate: number | null;
    /** 5 dernières, la plus récente d'abord. */
    last5: Result[];
    streak: { result: Result; count: number } | null;
    onChampion: { games: number; wins: number; winrate: number | null; kda: number | null } | null;
    mainRole: string | null;
  } | null;
  tags: Array<{ id: string; label: string; tone: Tone }>;
  /** Live Client Data (seulement si la partie tourne sur ce PC). */
  live: { kills: number; deaths: number; assists: number; cs: number; level: number } | null;
  loaded: { rank: boolean; mastery: boolean; recent: boolean };
  /**
   * Rôle : donné par le Live Client si disponible, sinon DÉDUIT (Spectator ne fournit pas les rôles)
   * à partir du sort Châtiment et des rôles joués récemment — c'est une estimation.
   */
  position: string | null;
  positionSource: 'liveclient' | 'inferred' | null;
}

export interface LiveTeamView {
  teamId: number;
  side: 'blue' | 'red';
  isMine: boolean;
  avgRank: { label: string; emblem: string } | null;
  avgRecentWinrate: number | null;
  players: LivePlayerView[];
}

export interface LiveGameView {
  gameId: number;
  queueId: number | null;
  queue: string;
  startedAt: string | null;
  elapsedS: number;
  gameTimeS: number | null;
  sources: { spectator: true; liveClient: boolean };
  status: 'partial' | 'complete';
  progress: { done: number; total: number };
  teams: LiveTeamView[];
  bans: Array<{ championId: number; teamId: number; icon: string }>;
}

interface PlayerState {
  p: CurrentGameParticipant;
  league: LeagueEntryDto[] | null;
  leagueLoaded: boolean;
  mastery: ChampionMasteryDto | null;
  masteryLoaded: boolean;
  recentIds: string[] | null;
  recentDone: boolean;
}

interface GameState {
  gameId: number;
  info: CurrentGameInfo;
  players: PlayerState[];
  done: number;
  total: number;
  cancelled: boolean;
}

interface RecentRow {
  match_id: string;
  game_end: number;
  win: number;
  remake: number;
  champion_id: number;
  kills: number;
  deaths: number;
  assists: number;
  position: string | null;
}

export interface LiveServiceDeps {
  db: Db;
  riot: RiotClient;
  accounts: AccountService;
  matches: MatchSyncService;
  liveClient: LiveClient;
  ddragon?: DataDragon;
  region: string;
  platform: string;
  dataDir: string;
  logger: Logger;
  now?: () => number;
}

export class LiveService {
  private state: GameState | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: LiveServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Partie en cours du compte suivi, ou null. Déclenche l'enrichissement au premier appel. */
  async get(): Promise<LiveGameView | null> {
    const { puuid } = await this.deps.accounts.me();
    const info = await getActiveGame(this.deps.riot, this.deps.platform, puuid, Priority.Live);
    if (!info) {
      if (this.state) this.state.cancelled = true;
      this.state = null;
      return null;
    }
    if (!this.state || this.state.gameId !== info.gameId) this.startGame(info);
    const live = await this.deps.liveClient.allGameData();
    return this.view(this.state!, puuid, live);
  }

  private startGame(info: CurrentGameInfo): void {
    if (this.state) this.state.cancelled = true;
    const players = info.participants.map(
      (p): PlayerState => ({
        p,
        league: null,
        leagueLoaded: false,
        mastery: null,
        masteryLoaded: false,
        recentIds: null,
        recentDone: false,
      }),
    );
    const enriched = players.filter((s) => !s.p.bot && s.p.puuid);
    const state: GameState = {
      gameId: info.gameId,
      info,
      players,
      done: 0,
      total: enriched.length * (3 + RECENT_GAMES), // league + maîtrise + ids + détails (au plus)
      cancelled: false,
    };
    this.state = state;
    this.deps.logger.info({ gameId: info.gameId, players: players.length }, 'Partie en cours détectée');
    void this.saveDebug(info);
    void this.enrich(state).catch((err) => this.deps.logger.warn({ err: String(err) }, 'Enrichissement interrompu'));
  }

  private async enrich(state: GameState): Promise<void> {
    const { riot, platform, region } = this.deps;
    const targets = state.players.filter((s) => !s.p.bot && s.p.puuid);
    const tick = (n = 1) => {
      state.done = Math.min(state.total, state.done + n);
    };
    const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        this.deps.logger.warn({ err: String(err) }, 'Requête joueur en échec');
        return null;
      }
    };

    // Vague 1 : rang + maîtrise (≈ 20 requêtes, quelques secondes)
    await Promise.all(
      targets.map(async (s) => {
        const puuid = s.p.puuid!;
        const [league, mastery] = await Promise.all([
          safe(() => getLeagueEntries(riot, platform, puuid, Priority.Live, LEAGUE_TTL_MS)),
          safe(() => getMasteryByChampion(riot, platform, puuid, s.p.championId, Priority.Live)),
        ]);
        s.league = league;
        s.leagueLoaded = true;
        s.mastery = mastery;
        s.masteryLoaded = true;
        tick(2);
      }),
    );
    if (state.cancelled) return;

    // Vague 2 : IDs des N dernières parties (même file si classée)
    const queueId = state.info.gameQueueConfigId;
    const queue = queueId && RANKED_QUEUE_TYPE[queueId] ? queueId : undefined;
    await Promise.all(
      targets.map(async (s) => {
        s.recentIds = (await safe(() => getMatchIds(riot, region, s.p.puuid!, { count: RECENT_GAMES, queue }, Priority.Live))) ?? [];
        tick();
        // Les parties absentes de la liste ne seront jamais téléchargées : on les compte comme faites.
        tick(RECENT_GAMES - s.recentIds.length);
      }),
    );

    // Vague 3 : détails, d'abord les 5 plus récentes de chacun, puis le reste.
    const has = this.deps.db.prepare<[string], { x: number }>('SELECT 1 AS x FROM matches WHERE match_id = ?');
    for (const [from, to] of [[0, FIRST_WAVE], [FIRST_WAVE, RECENT_GAMES]] as const) {
      await Promise.all(
        targets.map(async (s) => {
          for (const id of (s.recentIds ?? []).slice(from, to)) {
            if (state.cancelled) return;
            if (!has.get(id)) {
              const dto = await safe(() => getMatch(riot, region, id, Priority.Live));
              if (dto) this.deps.matches.store(dto);
            }
            tick();
          }
          if (to === RECENT_GAMES) s.recentDone = true;
        }),
      );
      if (state.cancelled) return;
    }
    state.done = state.total;
    this.deps.logger.info({ gameId: state.gameId }, 'Analyse des joueurs terminée');
  }

  private view(state: GameState, mePuuid: string, live: LiveAllGameData | null): LiveGameView {
    const info = state.info;
    const queueId = info.gameQueueConfigId ?? null;
    const queueType: RankedQueueType = queueId === 440 ? 'RANKED_FLEX_SR' : 'RANKED_SOLO_5x5';
    const players = state.players.map((s) => this.playerView(s, mePuuid, queueType, live));
    const myTeamId = state.players.find((s) => s.p.puuid === mePuuid)?.p.teamId ?? 100;

    const teams = [100, 200]
      .map((teamId): LiveTeamView => {
        const idx = state.players.map((s, i) => (s.p.teamId === teamId ? i : -1)).filter((i) => i >= 0);
        this.assignPositions(idx.map((i) => state.players[i]!), idx.map((i) => players[i]!), live);
        const members = idx.map((i) => players[i]!).sort((a, b) => roleIndex(a.position) - roleIndex(b.position));
        const ranked = members.map((m) => m.rank).filter((r): r is NonNullable<typeof r> => !!r);
        const abs = ranked.map((r) => absoluteLp(r.tier, r.division, r.lp)).filter((v): v is number => v !== null);
        const avg = abs.length ? rankFromAbsolute(abs.reduce((a, b) => a + b, 0) / abs.length) : null;
        const wrs = members.map((m) => m.recent?.winrate).filter((v): v is number => v !== null && v !== undefined);
        return {
          teamId,
          side: teamId === 100 ? 'blue' : 'red',
          isMine: teamId === myTeamId,
          avgRank: avg ? { label: rankLabel(avg.tier, avg.division), emblem: emblemPath(avg.tier) } : null,
          avgRecentWinrate: wrs.length ? round(wrs.reduce((a, b) => a + b, 0) / wrs.length, 3) : null,
          players: members,
        };
      })
      .sort((a, b) => Number(b.isMine) - Number(a.isMine));

    const startedAt = info.gameStartTime ? info.gameStartTime : null;
    return {
      gameId: info.gameId,
      queueId,
      queue: queueId ? queueLabel(queueId) : (info.gameMode ?? 'Partie'),
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      elapsedS: startedAt ? Math.max(0, Math.round((this.now() - startedAt) / 1000)) : (info.gameLength ?? 0),
      gameTimeS: typeof live?.gameData?.gameTime === 'number' ? Math.round(live.gameData.gameTime) : null,
      sources: { spectator: true, liveClient: !!live },
      status: state.done >= state.total ? 'complete' : 'partial',
      progress: { done: state.done, total: state.total },
      teams,
      bans: (info.bannedChampions ?? [])
        .filter((b) => b.championId > 0)
        .map((b) => ({ championId: b.championId, teamId: b.teamId, icon: `/api/assets/champion/${b.championId}.png` })),
    };
  }

  private playerView(s: PlayerState, mePuuid: string, queueType: RankedQueueType, live: LiveAllGameData | null): LivePlayerView {
    const p = s.p;
    const riotId = p.riotId || (p.bot ? 'Bot' : 'Joueur masqué');
    const championName = this.deps.ddragon?.championName(p.championId) ?? `Champion ${p.championId}`;

    const entry = s.league?.find((e) => e.queueType === queueType) ?? null;
    const rank = entry
      ? {
          queueType,
          label: rankLabel(entry.tier, entry.rank),
          tier: entry.tier,
          division: entry.rank,
          lp: entry.leaguePoints,
          wins: entry.wins,
          losses: entry.losses,
          winrate: entry.wins + entry.losses ? round(entry.wins / (entry.wins + entry.losses), 3) : null,
          hotStreak: !!entry.hotStreak,
          emblem: emblemPath(entry.tier),
        }
      : null;

    const mastery = s.mastery
      ? {
          level: s.mastery.championLevel,
          points: s.mastery.championPoints,
          lastPlayed: s.mastery.lastPlayTime ? new Date(s.mastery.lastPlayTime).toISOString() : null,
        }
      : null;

    const recent = p.puuid && s.recentIds ? this.recentStats(p.puuid, s.recentIds, p.championId) : null;
    const view: LivePlayerView = {
      puuid: p.puuid || null,
      riotId,
      gameName: riotId.split('#')[0] ?? riotId,
      isMe: !!p.puuid && p.puuid === mePuuid,
      bot: !!p.bot,
      champion: { id: p.championId, name: championName, icon: `/api/assets/champion/${p.championId}.png` },
      rank,
      mastery,
      recent,
      tags: [],
      live: liveScores(live, p, riotId),
      loaded: { rank: s.leagueLoaded, mastery: s.masteryLoaded, recent: s.recentDone },
      position: null,
      positionSource: null,
    };
    view.tags = computeTags(view, s.masteryLoaded);
    return view;
  }

  /**
   * Répartit les 5 rôles dans une équipe en maximisant un score (120 permutations, négligeable) :
   *  - rôle annoncé par le Live Client : +1000 ;
   *  - Châtiment (sort 11) : +200 en jungle, −200 ailleurs ;
   *  - parties récentes SUR CE CHAMPION dans ce rôle : +5 chacune ; dans ce rôle tous champions : +1.
   */
  private assignPositions(states: PlayerState[], views: LivePlayerView[], live: LiveAllGameData | null): void {
    if (states.length !== POSITIONS.length) return;
    const scores = states.map((s, i) => {
      const fromLive = liveFor(live, s.p)?.position?.toUpperCase();
      const roles = s.p.puuid && s.recentIds?.length ? this.roleCounts(s.p.puuid, s.recentIds, s.p.championId) : null;
      const smite = s.p.spell1Id === SMITE || s.p.spell2Id === SMITE;
      if (fromLive && (POSITIONS as readonly string[]).includes(fromLive)) views[i]!.positionSource = 'liveclient';
      return POSITIONS.map((role) => {
        let score = 0;
        if (fromLive === role) score += 1000;
        if (smite) score += role === 'JUNGLE' ? 200 : -200;
        if (roles) score += 5 * (roles.onChampion.get(role) ?? 0) + (roles.all.get(role) ?? 0);
        return score;
      });
    });
    let best: number[] = PERMUTATIONS[0]!;
    let bestScore = -Infinity;
    for (const perm of PERMUTATIONS) {
      const total = perm.reduce((sum, role, i) => sum + scores[i]![role]!, 0);
      if (total > bestScore) {
        bestScore = total;
        best = perm;
      }
    }
    best.forEach((role, i) => {
      views[i]!.position = POSITIONS[role]!;
      views[i]!.positionSource ??= 'inferred';
    });
  }

  private roleCounts(puuid: string, ids: string[], championId: number): { all: Map<string, number>; onChampion: Map<string, number> } {
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.deps.db
      .prepare<string[], { champion_id: number; position: string | null }>(
        `SELECT champion_id, position FROM match_participants WHERE puuid = ? AND match_id IN (${placeholders})`,
      )
      .all(puuid, ...ids);
    const all = new Map<string, number>();
    const onChampion = new Map<string, number>();
    for (const r of rows) {
      if (!r.position) continue;
      all.set(r.position, (all.get(r.position) ?? 0) + 1);
      if (r.champion_id === championId) onChampion.set(r.position, (onChampion.get(r.position) ?? 0) + 1);
    }
    return { all, onChampion };
  }

  private recentStats(puuid: string, ids: string[], championId: number): LivePlayerView['recent'] {
    if (!ids.length) return { games: 0, wins: 0, winrate: null, last5: [], streak: null, onChampion: null, mainRole: null };
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.deps.db
      .prepare<string[], RecentRow>(
        `SELECT m.match_id, m.game_end, p.win, p.remake, p.champion_id, p.kills, p.deaths, p.assists, p.position
         FROM match_participants p JOIN matches m ON m.match_id = p.match_id
         WHERE p.puuid = ? AND m.match_id IN (${placeholders}) ORDER BY m.game_end DESC`,
      )
      .all(puuid, ...ids)
      .filter((r) => r.remake === 0);
    if (!rows.length) return null; // pas encore téléchargées

    const wins = rows.filter((r) => r.win === 1).length;
    const results = rows.map((r): Result => (r.win === 1 ? 'W' : 'L'));
    const onChamp = rows.filter((r) => r.champion_id === championId);
    const champKills = onChamp.reduce((t, r) => t + r.kills + r.assists, 0);
    const champDeaths = onChamp.reduce((t, r) => t + r.deaths, 0);
    const roles = new Map<string, number>();
    for (const r of rows) if (r.position) roles.set(r.position, (roles.get(r.position) ?? 0) + 1);
    const mainRole = [...roles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      games: rows.length,
      wins,
      winrate: round(wins / rows.length, 3),
      last5: results.slice(0, 5),
      streak: computeStreaks([...results].reverse()).current,
      onChampion: onChamp.length
        ? {
            games: onChamp.length,
            wins: onChamp.filter((r) => r.win === 1).length,
            winrate: round(onChamp.filter((r) => r.win === 1).length / onChamp.length, 3),
            kda: round(champKills / Math.max(1, champDeaths), 2),
          }
        : null,
      mainRole,
    };
  }

  private async saveDebug(info: CurrentGameInfo): Promise<void> {
    try {
      const dir = path.join(this.deps.dataDir, 'debug');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'spectator-last.json'), JSON.stringify(info, null, 2));
    } catch {
      /* non bloquant */
    }
  }
}

const SMITE = 11;
const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;
const PERMUTATIONS: number[][] = (function permute(items: number[]): number[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) => permute([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
})([0, 1, 2, 3, 4]);

function roleIndex(position: string | null): number {
  const i = POSITIONS.indexOf((position ?? '') as (typeof POSITIONS)[number]);
  return i < 0 ? POSITIONS.length : i;
}

/** 1 919 463 → « 1,9 M » ; 950 000 → « 950 k ». */
export function formatPoints(points: number): string {
  if (points >= 1_000_000) return `${(points / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (points >= 1_000) return `${Math.round(points / 1_000)} k`;
  return String(points);
}

/** Ligne Live Client d'un joueur Spectator (même Riot ID). */
function liveFor(live: LiveAllGameData | null, p: CurrentGameParticipant): LivePlayer | undefined {
  if (!live?.allPlayers || !p.riotId) return undefined;
  const wanted = p.riotId.toLowerCase();
  return live.allPlayers.find((x) => {
    const id = x.riotId ?? (x.riotIdGameName ? `${x.riotIdGameName}#${x.riotIdTagLine ?? ''}` : undefined);
    return id?.toLowerCase() === wanted;
  });
}

/** Associe un joueur Spectator à sa ligne Live Client (même Riot ID). */
function liveScores(live: LiveAllGameData | null, p: CurrentGameParticipant, riotId: string): LivePlayerView['live'] {
  if (!live?.allPlayers || !p.riotId) return null;
  const wanted = riotId.toLowerCase();
  const lp: LivePlayer | undefined = live.allPlayers.find((x) => {
    const id = x.riotId ?? (x.riotIdGameName ? `${x.riotIdGameName}#${x.riotIdTagLine ?? ''}` : undefined);
    return id?.toLowerCase() === wanted;
  });
  if (!lp) return null;
  return {
    kills: lp.scores?.kills ?? 0,
    deaths: lp.scores?.deaths ?? 0,
    assists: lp.scores?.assists ?? 0,
    cs: lp.scores?.creepScore ?? 0,
    level: lp.level ?? 0,
  };
}

/** Repères « Porofessor-like », factuels et calculés uniquement à partir des données Riot. */
export function computeTags(v: LivePlayerView, masteryLoaded: boolean): LivePlayerView['tags'] {
  const tags: LivePlayerView['tags'] = [];
  const r = v.recent;
  if (r?.streak && r.streak.count >= 3) {
    tags.push(
      r.streak.result === 'W'
        ? { id: 'win_streak', label: `${r.streak.count} V d'affilée`, tone: 'strong' }
        : { id: 'loss_streak', label: `${r.streak.count} D d'affilée`, tone: 'weak' },
    );
  } else if (v.rank?.hotStreak) {
    tags.push({ id: 'hot_streak', label: 'En série', tone: 'strong' });
  }
  if (v.mastery && v.mastery.points >= 300_000) {
    tags.push({ id: 'otp', label: `OTP · ${formatPoints(v.mastery.points)}`, tone: 'strong' });
  } else if (r?.onChampion && r.games >= 8 && r.onChampion.games / r.games >= 0.5) {
    tags.push({ id: 'main', label: 'Spécialiste', tone: 'strong' });
  } else if (masteryLoaded && (!v.mastery || v.mastery.points < 5_000) && !v.bot && v.puuid) {
    tags.push({ id: 'new_champ', label: 'Peu joué', tone: 'weak' });
  }
  if (r?.onChampion && r.onChampion.games >= 5 && r.onChampion.winrate !== null) {
    if (r.onChampion.winrate >= 0.65) tags.push({ id: 'champ_wr_high', label: `WR champ ${Math.round(r.onChampion.winrate * 100)} %`, tone: 'strong' });
    else if (r.onChampion.winrate <= 0.35) tags.push({ id: 'champ_wr_low', label: `WR champ ${Math.round(r.onChampion.winrate * 100)} %`, tone: 'weak' });
  }
  if (r && r.games >= 10 && r.winrate !== null && !tags.some((t) => t.id.endsWith('streak'))) {
    if (r.winrate >= 0.65) tags.push({ id: 'in_form', label: 'En forme', tone: 'strong' });
    else if (r.winrate <= 0.35) tags.push({ id: 'struggling', label: 'En difficulté', tone: 'weak' });
  }
  return tags.slice(0, 3);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
