import { absoluteLp } from './rank.js';

/**
 * Attribution des gains de LP par partie.
 *
 * Riot ne renvoie pas le LP gagné par partie : on le déduit des snapshots League-V4.
 * Entre deux snapshots A et B, le nombre de parties jouées est
 * (B.wins + B.losses) − (A.wins + A.losses) et l'écart de LP vaut absoluteLp(B) − absoluteLp(A).
 *
 *  - 1 partie entre A et B          → gain exact (source « snapshot »)
 *  - n > 1 parties entre A et B     → total exact, réparti entre les parties (source « estimated »)
 *  - 0 partie mais LP différent     → ajustement (esquive, decay…), hors parties
 *  - partie sans snapshot encadrant → APPROXIMATIF (source « estimated ») : c'est le cas de toutes
 *    les parties antérieures au premier snapshot, et des parties pas encore suivies d'un snapshot.
 *    On utilise alors la médiane des gains/pertes exacts connus, ou ±DEFAULT_LP_ESTIMATE à défaut.
 *
 * Fonction pure, recalculée à chaque requête : une partie arrivée en retard dans Match-V5
 * est automatiquement rattachée au bon intervalle au calcul suivant.
 */

export interface RankSnapshot {
  id: number;
  tier: string;
  division: string;
  lp: number;
  wins: number;
  losses: number;
  takenAt: number;
}

export interface RankedGame {
  matchId: string;
  endedAt: number;
  win: boolean;
  remake: boolean;
}

export type LpSource = 'snapshot' | 'estimated';

export interface GameLp {
  lpDelta: number | null;
  source: LpSource;
}

export interface LpAdjustment {
  at: number;
  delta: number;
}

export interface LpAttribution {
  perGame: Map<string, GameLp>;
  adjustments: LpAdjustment[];
}

/** Valeur de repli quand aucun gain exact n'est encore connu (approximation grossière). */
export const DEFAULT_LP_ESTIMATE = 20;

/**
 * Tolérance avant le snapshot A : League-V4 peut se mettre à jour quelques instants après
 * la fin de partie ; une partie terminée juste avant A peut donc ne compter que dans B.
 */
const SLACK_BEFORE_MS = 3 * 60_000;

export function attributeLp(snapshots: readonly RankSnapshot[], games: readonly RankedGame[]): LpAttribution {
  const snaps = [...snapshots].sort((a, b) => a.takenAt - b.takenAt);
  const played = games.filter((g) => !g.remake).sort((a, b) => a.endedAt - b.endedAt);
  const perGame = new Map<string, GameLp>();
  const adjustments: LpAdjustment[] = [];
  const assigned = new Set<string>();

  // Remake : pas de victoire/défaite comptée et pas de LP pour les joueurs restés en jeu.
  for (const g of games) if (g.remake) perGame.set(g.matchId, { lpDelta: 0, source: 'estimated' });

  interface Group { games: RankedGame[]; lpDelta: number }
  const multiGroups: Group[] = [];

  for (let i = 0; i + 1 < snaps.length; i++) {
    const a = snaps[i]!;
    const b = snaps[i + 1]!;
    const absA = absoluteLp(a.tier, a.division, a.lp);
    const absB = absoluteLp(b.tier, b.division, b.lp);
    const gamesDelta = b.wins + b.losses - (a.wins + a.losses);
    if (absA === null || absB === null || gamesDelta < 0) continue; // nouvelle saison / données incohérentes
    const lpDelta = absB - absA;

    if (gamesDelta === 0) {
      if (lpDelta !== 0) adjustments.push({ at: b.takenAt, delta: lpDelta });
      continue;
    }

    // On garde les `gamesDelta` parties les PLUS RÉCENTES de la fenêtre : une partie finie juste
    // avant A (dans la tolérance) n'appartient à B que si League-V4 ne l'avait pas encore comptée,
    // auquel cas gamesDelta l'inclut forcément avec toutes celles d'après.
    const picked = played
      .filter((g) => !assigned.has(g.matchId) && g.endedAt > a.takenAt - SLACK_BEFORE_MS && g.endedAt <= b.takenAt)
      .slice(-gamesDelta);
    if (picked.length !== gamesDelta) continue; // parties pas encore synchronisées : on réessaiera
    for (const g of picked) assigned.add(g.matchId);

    if (gamesDelta === 1) perGame.set(picked[0]!.matchId, { lpDelta, source: 'snapshot' });
    else multiGroups.push({ games: picked, lpDelta });
  }

  // Médianes des gains et pertes exacts, utilisées pour toutes les estimations.
  const exact = [...perGame.entries()].filter(([, v]) => v.source === 'snapshot').map(([id, v]) => ({ id, d: v.lpDelta! }));
  const winGain = median(exact.filter((e) => e.d > 0).map((e) => e.d)) ?? DEFAULT_LP_ESTIMATE;
  const lossCost = median(exact.filter((e) => e.d < 0).map((e) => -e.d)) ?? DEFAULT_LP_ESTIMATE;

  // Plusieurs parties entre deux snapshots : le total est exact, la répartition estimée.
  for (const group of multiGroups) {
    const guesses = group.games.map((g) => (g.win ? winGain : -lossCost));
    const residual = group.lpDelta - guesses.reduce((s, v) => s + v, 0);
    const deltas = distribute(guesses, residual);
    group.games.forEach((g, i) => perGame.set(g.matchId, { lpDelta: deltas[i]!, source: 'estimated' }));
  }

  // APPROXIMATIF : parties hors de tout intervalle de snapshots (notamment avant le premier).
  for (const g of played) {
    if (!perGame.has(g.matchId)) {
      perGame.set(g.matchId, { lpDelta: g.win ? winGain : -lossCost, source: 'estimated' });
    }
  }

  return { perGame, adjustments };
}

/** Répartit `residual` sur les estimations en conservant des entiers et la somme exacte. */
function distribute(guesses: number[], residual: number): number[] {
  const n = guesses.length;
  const base = Math.trunc(residual / n);
  let rest = residual - base * n;
  return guesses.map((g) => {
    let extra = base;
    if (rest !== 0) {
      extra += Math.sign(rest);
      rest -= Math.sign(rest);
    }
    return g + extra;
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
