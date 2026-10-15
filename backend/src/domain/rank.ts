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

/** « Émeraude II », ou « Maître » pour l'apex. */
export function rankLabel(tier: string, division: string): string {
  const t = tier.toUpperCase();
  const name = TIER_FR[t] ?? tier;
  return (APEX_TIERS as readonly string[]).includes(t) ? name : `${name} ${division}`;
}
