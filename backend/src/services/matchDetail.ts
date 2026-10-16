import type { Db } from '../db/index.js';
import type { DataDragon } from '../ddragon/ddragon.js';
import { queueLabel } from '../domain/queues.js';
import { emblemPath, rankLabel } from '../domain/rank.js';
import type { LeagueEntryDto, MatchDto, ParticipantDto } from '../riot/types.js';
import type { LpSource } from '../domain/lp.js';
import type { AccountService } from './accountService.js';

/**
 * Détail d'une partie stockée : les 10 joueurs et tous les repères calculés ici
 * (le widget n'a qu'à les afficher) :
 *  - « badges » : meilleur de la partie (★) en dégâts, CS, kills, KDA, or, participation ;
 *  - « duels » : les 5 lanes face à face (Top vs Top…) avec stats détaillées et vainqueur par stat ;
 *  - LP de la partie et rang juste après (compte suivi), rang actuel des 10 joueurs.
 * Les CS/min classent comme les CS (même durée pour tous) : un seul badge « cs ».
 */

export type BadgeId = 'damage' | 'cs' | 'kills' | 'kda' | 'gold' | 'kp';

export const BADGE_LABELS: Record<BadgeId, string> = {
  damage: 'Top dégâts',
  cs: 'Top CS',
  kills: 'Top kills',
  kda: 'Meilleur KDA',
  gold: 'Top or',
  kp: 'Top participation',
};

export const POSITION_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;

export interface PlayerRank {
  label: string;
  tier: string;
  lp: number;
  emblem: string;
}

export interface MatchPlayer {
  puuid: string;
  riotId: string;
  isMe: boolean;
  champion: { id: number; name: string; displayName: string; icon: string };
  position: string | null;
  level: number | null;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  cs: number;
  csPerMin: number;
  damage: number;
  /** Part des dégâts de l'équipe (0-1). */
  damageShare: number;
  gold: number;
  vision: number;
  killParticipation: number | null;
  badges: BadgeId[];
  /** Rang ACTUEL dans la file de la partie (pas celui du jour de la partie) ; null = non classé / inconnu. */
  rank: PlayerRank | null;
}

export interface MatchTeam {
  teamId: number;
  side: 'blue' | 'red';
  win: boolean;
  isMine: boolean;
  kills: number;
  deaths: number;
  assists: number;
  gold: number;
  damage: number;
  players: MatchPlayer[];
}

export type StatFormat = 'int' | 'dec1' | 'dec2' | 'k' | 'pct';

export type DuelGroup = 'combat' | 'farm' | 'map';

export const DUEL_GROUP_LABELS: Record<DuelGroup, string> = { combat: 'Combat', farm: 'Farm & or', map: 'Carte' };

export interface DuelStatLine {
  id: string;
  group: DuelGroup;
  label: string;
  ally: number;
  enemy: number;
  format: StatFormat;
  /** Qui a l'avantage sur cette stat (null = égalité). */
  winner: 'ally' | 'enemy' | null;
  /** ally − enemy. */
  diff: number;
  /** Ampleur de l'avantage, 0 à 1 (|écart| / plus grande valeur) — longueur de la barre. */
  advantage: number;
}

export interface LaneDuel {
  position: string;
  isMine: boolean;
  /** PUUID des deux joueurs (cf. teams[].players). */
  ally: string;
  enemy: string;
  /** Écart d'or (allié − ennemi), pour un aperçu rapide de chaque lane. */
  goldDiff: number;
  stats: DuelStatLine[];
}

export interface MatchDetail {
  matchId: string;
  queueId: number;
  queue: string;
  endedAt: string;
  durationS: number;
  remake: boolean;
  /** Résultat du compte suivi ; null s'il n'a pas joué cette partie. */
  result: 'W' | 'L' | 'REMAKE' | null;
  /** LP gagnés/perdus par le compte suivi (parties classées uniquement). */
  lp: { delta: number | null; source: LpSource } | null;
  /** Rang du compte suivi juste après la partie (snapshot), null si non relevé. */
  rankAfter: (PlayerRank & { division: string }) | null;
  badgeLabels: Record<BadgeId, string>;
  duelGroupLabels: Record<DuelGroup, string>;
  teams: MatchTeam[];
  /** Les 5 lanes face à face (vides en ARAM/Arena, où il n'y a pas de rôles). */
  duels: LaneDuel[];
}

export interface MatchLpInfo {
  lp: { delta: number | null; source: LpSource } | null;
  rankAfter: { tier: string; division: string; lp: number } | null;
}

export interface MatchDetailDeps {
  db: Db;
  accounts: AccountService;
  ddragon?: DataDragon;
  /** LP de la partie + rang juste après, pour le compte suivi (cf. SessionService). */
  lpInfo?: (puuid: string, matchId: string) => MatchLpInfo;
  /** Entrées League-V4 d'un joueur (en cache) ; erreurs → null. */
  league?: (puuid: string) => Promise<LeagueEntryDto[] | null>;
}

interface Row {
  puuid: string;
  team_id: number;
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
  riot_id_name: string | null;
  riot_id_tag: string | null;
}

export class MatchNotFoundError extends Error {
  constructor(matchId: string) {
    super(`Partie inconnue : ${matchId}`);
    this.name = 'MatchNotFoundError';
  }
}

const RANK_TIMEOUT_MS = 6_000;

export class MatchDetailService {
  private readonly matchStmt;
  private readonly playersStmt;

  constructor(private readonly deps: MatchDetailDeps) {
    this.matchStmt = deps.db.prepare<[string], { queue_id: number; game_end: number; duration_s: number; raw_json: string }>(
      'SELECT queue_id, game_end, duration_s, raw_json FROM matches WHERE match_id = ?',
    );
    this.playersStmt = deps.db.prepare<[string], Row>(
      `SELECT puuid, team_id, champion_id, champion_name, position, win, remake, kills, deaths, assists, cs, vision,
              gold, damage, kill_participation, champ_level, riot_id_name, riot_id_tag
       FROM match_participants WHERE match_id = ? ORDER BY team_id, rowid`,
    );
  }

  async get(matchId: string): Promise<MatchDetail> {
    const match = this.matchStmt.get(matchId);
    if (!match) throw new MatchNotFoundError(matchId);
    const rows = this.playersStmt.all(matchId);
    const raw = JSON.parse(match.raw_json) as MatchDto;
    const rawByPuuid = new Map<string, ParticipantDto>(raw.info.participants.map((p) => [p.puuid, p]));
    const { puuid: mePuuid } = await this.deps.accounts.me();
    await this.deps.ddragon?.ensureLoaded();

    // Rang actuel des 10 joueurs (en parallèle, en cache) — jamais bloquant au-delà de RANK_TIMEOUT_MS.
    const queueType = match.queue_id === 440 ? 'RANKED_FLEX_SR' : 'RANKED_SOLO_5x5';
    const ranks = await this.ranks(rows.map((r) => r.puuid), queueType);

    const minutes = match.duration_s / 60;
    const teamDamage = new Map<number, number>();
    for (const r of rows) teamDamage.set(r.team_id, (teamDamage.get(r.team_id) ?? 0) + r.damage);

    const players = rows.map((r): MatchPlayer & { teamId: number; win: boolean } => ({
      teamId: r.team_id,
      win: r.win === 1,
      puuid: r.puuid,
      riotId: r.riot_id_name ? `${r.riot_id_name}#${r.riot_id_tag ?? ''}` : 'Joueur',
      isMe: r.puuid === mePuuid,
      champion: {
        id: r.champion_id,
        name: r.champion_name,
        displayName: this.deps.ddragon?.championName(r.champion_id) ?? r.champion_name,
        icon: `/api/assets/champion/${r.champion_id}.png`,
      },
      position: validPosition(r.position),
      level: r.champ_level,
      kills: r.kills,
      deaths: r.deaths,
      assists: r.assists,
      kda: round((r.kills + r.assists) / Math.max(1, r.deaths), 2),
      cs: r.cs,
      csPerMin: minutes ? round(r.cs / minutes, 1) : 0,
      damage: r.damage,
      damageShare: round(r.damage / Math.max(1, teamDamage.get(r.team_id) ?? 0), 3),
      gold: r.gold,
      vision: r.vision,
      killParticipation: r.kill_participation === null ? null : round(r.kill_participation, 3),
      badges: [],
      rank: ranks.get(r.puuid) ?? null,
    }));

    // ★ Meilleur de la partie (ex æquo : tous les meilleurs) — rien si la valeur max est nulle.
    const metrics: Record<BadgeId, (p: MatchPlayer) => number> = {
      damage: (p) => p.damage,
      cs: (p) => p.cs,
      kills: (p) => p.kills,
      kda: (p) => p.kda,
      gold: (p) => p.gold,
      kp: (p) => p.killParticipation ?? 0,
    };
    for (const [id, f] of Object.entries(metrics) as [BadgeId, (p: MatchPlayer) => number][]) {
      const max = Math.max(...players.map(f));
      if (max > 0) for (const p of players) if (f(p) === max) p.badges.push(id);
    }

    fillMissingPositions(players);

    const me = players.find((p) => p.isMe);
    const myTeamId = me?.teamId ?? 100;
    const byRole = (a: MatchPlayer, b: MatchPlayer) => roleIndex(a.position) - roleIndex(b.position);
    const teams = [...new Set(players.map((p) => p.teamId))]
      .map((teamId): MatchTeam => {
        const members = players.filter((p) => p.teamId === teamId);
        return {
          teamId,
          side: teamId === 100 ? 'blue' : 'red',
          win: members[0]?.win ?? false,
          isMine: teamId === myTeamId,
          kills: members.reduce((s, p) => s + p.kills, 0),
          deaths: members.reduce((s, p) => s + p.deaths, 0),
          assists: members.reduce((s, p) => s + p.assists, 0),
          gold: members.reduce((s, p) => s + p.gold, 0),
          damage: members.reduce((s, p) => s + p.damage, 0),
          players: members.map(({ teamId: _t, win: _w, ...p }) => p).sort(byRole),
        };
      })
      .sort((a, b) => Number(b.isMine) - Number(a.isMine));

    // Duels : même rôle de part et d'autre (absents en ARAM, où les rôles sont vides).
    const duels: LaneDuel[] = [];
    for (const position of POSITION_ORDER) {
      const ally = players.find((p) => p.teamId === myTeamId && p.position === position);
      const enemy = players.find((p) => p.teamId !== myTeamId && p.position === position);
      if (!ally || !enemy) continue;
      duels.push({
        position,
        isMine: ally.isMe,
        ally: ally.puuid,
        enemy: enemy.puuid,
        goldDiff: ally.gold - enemy.gold,
        stats: duelStats(ally, enemy, rawByPuuid.get(ally.puuid), rawByPuuid.get(enemy.puuid)),
      });
    }

    const remake = rows.some((r) => r.remake === 1);
    const lpInfo = me ? this.deps.lpInfo?.(mePuuid, matchId) : undefined;
    const after = lpInfo?.rankAfter;
    return {
      matchId,
      queueId: match.queue_id,
      queue: queueLabel(match.queue_id),
      endedAt: new Date(match.game_end).toISOString(),
      durationS: match.duration_s,
      remake,
      result: me ? (remake ? 'REMAKE' : me.win ? 'W' : 'L') : null,
      lp: lpInfo?.lp ?? null,
      rankAfter: after
        ? { label: rankLabel(after.tier, after.division), tier: after.tier, division: after.division, lp: after.lp, emblem: emblemPath(after.tier) }
        : null,
      badgeLabels: BADGE_LABELS,
      duelGroupLabels: DUEL_GROUP_LABELS,
      teams,
      duels,
    };
  }

  private async ranks(puuids: string[], queueType: string): Promise<Map<string, PlayerRank>> {
    const out = new Map<string, PlayerRank>();
    const league = this.deps.league;
    if (!league) return out;
    const work = Promise.all(
      puuids.map(async (puuid) => {
        const entries = await league(puuid);
        const e = entries?.find((x) => x.queueType === queueType);
        if (e) out.set(puuid, { label: rankLabel(e.tier, e.rank), tier: e.tier, lp: e.leaguePoints, emblem: emblemPath(e.tier) });
      }),
    );
    await Promise.race([work, new Promise((r) => setTimeout(r, RANK_TIMEOUT_MS).unref?.())]);
    return out;
  }
}

/** Riot renvoie parfois « Invalid » (ou vide) quand il n'a pas su déterminer le rôle. */
export function validPosition(position: string | null | undefined): string | null {
  return position && (POSITION_ORDER as readonly string[]).includes(position) ? position : null;
}

/**
 * Complète les rôles manquants par élimination, équipe par équipe : les joueurs sans rôle
 * reçoivent, dans l'ordre, les rôles restés libres (ex. Vladimir « Invalid » → BOTTOM si
 * c'est le seul rôle libre). Rien n'est fait si le nombre ne correspond pas.
 */
export function fillMissingPositions(players: Array<{ teamId: number; position: string | null }>): void {
  for (const teamId of new Set(players.map((p) => p.teamId))) {
    const team = players.filter((p) => p.teamId === teamId);
    const taken = new Set(team.map((p) => p.position).filter(Boolean));
    const free = POSITION_ORDER.filter((r) => !taken.has(r));
    const missing = team.filter((p) => !p.position);
    if (missing.length && missing.length === free.length) missing.forEach((p, i) => (p.position = free[i]!));
  }
}

function roleIndex(position: string | null): number {
  const i = POSITION_ORDER.indexOf((position ?? '') as (typeof POSITION_ORDER)[number]);
  return i < 0 ? POSITION_ORDER.length : i;
}

/**
 * Stats d'un duel, volontairement resserrées (9) et groupées pour rester lisibles d'un coup d'œil :
 *  - Combat : KDA, dégâts, participation ;
 *  - Farm & or : CS/min, CS à 10 min, or ;
 *  - Carte : vision, dégâts aux bâtiments, solo kills.
 */
function duelStats(a: MatchPlayer, e: MatchPlayer, ra: ParticipantDto | undefined, re: ParticipantDto | undefined): DuelStatLine[] {
  const ch = (p: ParticipantDto | undefined, k: string) => Number((p?.challenges as Record<string, unknown> | undefined)?.[k] ?? 0);
  const n = (p: ParticipantDto | undefined, k: string) => Number((p as unknown as Record<string, unknown> | undefined)?.[k] ?? 0);
  const cs10 = (p: ParticipantDto | undefined) => ch(p, 'laneMinionsFirst10Minutes') + ch(p, 'jungleCsBefore10Minutes');

  const lines: Array<[string, DuelGroup, string, number, number, StatFormat]> = [
    ['kda', 'combat', 'KDA', a.kda, e.kda, 'dec2'],
    ['damage', 'combat', 'Dégâts', a.damage, e.damage, 'k'],
    ['kp', 'combat', 'Participation', a.killParticipation ?? 0, e.killParticipation ?? 0, 'pct'],
    ['csPerMin', 'farm', 'CS / min', a.csPerMin, e.csPerMin, 'dec1'],
    ['cs10', 'farm', 'CS à 10 min', cs10(ra), cs10(re), 'int'],
    ['gold', 'farm', 'Or', a.gold, e.gold, 'k'],
    ['vision', 'map', 'Vision', a.vision, e.vision, 'int'],
    ['buildings', 'map', 'Dégâts bâtiments', n(ra, 'damageDealtToBuildings'), n(re, 'damageDealtToBuildings'), 'k'],
    ['soloKills', 'map', 'Solo kills', ch(ra, 'soloKills'), ch(re, 'soloKills'), 'int'],
  ];

  return lines.map(([id, group, label, ally, enemy, format]) => {
    const max = Math.max(Math.abs(ally), Math.abs(enemy));
    return {
      id,
      group,
      label,
      ally,
      enemy,
      format,
      winner: ally === enemy ? null : ally > enemy ? 'ally' : 'enemy',
      diff: round(ally - enemy, 2),
      advantage: max ? round(Math.abs(ally - enemy) / max, 3) : 0,
    };
  });
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
