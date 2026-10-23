/**
 * Échelle de LP « absolue » pour comparer deux rangs, y compris à travers une promotion
 * ou une relégation : palier × 400 + division × 100 + LP.
 * Master, Grandmaster et Challenger partagent la même base (pas de divisions, LP continus).
 */

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'] as const;
const APEX_TIERS = ['MASTER', 'GRANDMASTER', 'CHALLENGER'] as const;
const DIVISIONS: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3 };
const APEX_BASE = TIERS.length * 400;

export function absoluteLp(tier: string, division: string, lp: number): number | null {
  const t = tier.toUpperCase();
  if ((APEX_TIERS as readonly string[]).includes(t)) return APEX_BASE + lp;
  const tierIndex = (TIERS as readonly string[]).indexOf(t);
  const div = DIVISIONS[division.toUpperCase()];
  if (tierIndex < 0 || div === undefined) return null;
  return tierIndex * 400 + div * 100 + lp;
}

/**
 * Inverse d'absoluteLp, pour afficher un rang moyen. Au-delà de Diamant I, impossible de distinguer
 * Master / Grandmaster / Challenger (seuils variables) : on renvoie MASTER.
 */
export function rankFromAbsolute(abs: number): { tier: string; division: string; lp: number } {
  const value = Math.max(0, Math.round(abs));
  if (value >= APEX_BASE) return { tier: 'MASTER', division: 'I', lp: value - APEX_BASE };
  const tier = TIERS[Math.floor(value / 400)]!;
  const div = Math.floor((value % 400) / 100);
  return { tier, division: ['IV', 'III', 'II', 'I'][div]!, lp: value % 100 };
}

/** Chemin de l'emblème servi par le backend. */
export function emblemPath(tier: string): string {
  return `/api/assets/rank/${tier.toLowerCase()}.png`;
}

const TIER_FR: Record<string, string> = {
  IRON: 'Fer',
  BRONZE: 'Bronze',
  SILVER: 'Argent',
  GOLD: 'Or',
  PLATINUM: 'Platine',
  EMERALD: 'Émeraude',
  DIAMOND: 'Diamant',
  MASTER: 'Maître',
  GRANDMASTER: 'Grand Maître',
  CHALLENGER: 'Challenger',
};

/** Nom français du palier seul : « Émeraude », « Maître »… */
export function tierLabel(tier: string): string {
  return TIER_FR[tier.toUpperCase()] ?? tier;
}

/** « Émeraude II », ou « Maître » pour l'apex. */
export function rankLabel(tier: string, division: string): string {
  const t = tier.toUpperCase();
  const name = TIER_FR[t] ?? tier;
  return (APEX_TIERS as readonly string[]).includes(t) ? name : `${name} ${division}`;
}
