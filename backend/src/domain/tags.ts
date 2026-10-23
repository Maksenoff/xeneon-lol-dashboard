/**
 * Repères affichés sous chaque joueur pendant une partie (façon Porofessor).
 * Tous sont FACTUELS, calculés à partir des seules données Riot (League-V4, Champion-Mastery-V4,
 * Match-V5) — aucun jugement du type « smurf ».
 *
 * Familles : streak (séries), champion (expérience sur le champion joué), form (forme récente),
 * profile (profil du compte). Tons : elite (exceptionnel), strong (point fort), weak (point faible),
 * info (neutre).
 *
 * Chaque repère porte un titre et une explication en clair, affichés dans la bulle qui s'ouvre
 * quand on touche le repère dans le widget.
 */

import { tierLabel } from './rank.js';

export type TagCategory = 'streak' | 'champion' | 'playstyle' | 'form' | 'profile';
export type TagTone = 'elite' | 'strong' | 'weak' | 'info';

export type TagId =
  | 'otp'
  | 'first_time'
  | 'win_streak'
  | 'loss_streak'
  | 'hot_streak'
  | 'good_smite'
  | 'bad_smite'
  | 'duelist'
  | 'teamfighter'
  | 'death_prone'
  | 'main'
  | 'new_champ'
  | 'off_role'
  | 'champ_wr_high'
  | 'champ_wr_low'
  | 'champ_kda'
  | 'in_form'
  | 'struggling'
  | 'fresh_blood'
  | 'low_games'
  | 'veteran';

export interface Tag {
  id: TagId;
  /** Texte court de la pastille, ex. « OTP · 70 % ». */
  label: string;
  category: TagCategory;
  tone: TagTone;
  /** Nom du repère dans la bulle, ex. « One-trick ». */
  title: string;
  /** Ce que le repère veut dire, en clair. */
  explain: string;
  /** Le chiffre précis pour ce joueur, ex. « 14 de ses 20 dernières parties sur Vayne ». */
  hint: string;
}

export interface TagDefinition {
  id: TagId;
  category: TagCategory;
  tone: TagTone;
  title: string;
  example: string;
  /** Règle de déclenchement (pour la documentation). */
  rule: string;
  /** Explication en clair (bulle du widget). */
  explain: string;
}

/** Catalogue, dans l'ordre de priorité d'affichage (les premiers retenus l'emportent). */
export const TAG_CATALOG: ReadonlyArray<TagDefinition> = [
  {
    id: 'otp', category: 'champion', tone: 'elite', title: 'One-trick (OTP)', example: 'OTP',
    rule: 'Au moins 65 % de ses 8+ dernières parties sur le champion joué',
    explain: 'Ce joueur joue presque uniquement ce champion. Il en connaît parfaitement les forces, les combos et les match-ups : attends-toi à un niveau de maîtrise élevé.',
  },
  {
    id: 'first_time', category: 'champion', tone: 'weak', title: 'Première fois', example: '1re fois',
    rule: 'Aucun point de maîtrise : jamais joué ce champion',
    explain: 'Ce joueur n\'a encore jamais joué ce champion (zéro point de maîtrise). Il risque de manquer de réflexes et de mal connaître ses limites.',
  },
  {
    id: 'win_streak', category: 'streak', tone: 'strong', title: 'Série de victoires', example: "4 V d'affilée",
    rule: '3 victoires consécutives ou plus sur ses dernières parties',
    explain: 'Ce joueur enchaîne les victoires sur ses dernières parties : il est en confiance et probablement dans une bonne dynamique.',
  },
  {
    id: 'loss_streak', category: 'streak', tone: 'weak', title: 'Série de défaites', example: "3 D d'affilée",
    rule: '3 défaites consécutives ou plus sur ses dernières parties',
    explain: 'Ce joueur enchaîne les défaites sur ses dernières parties. Il peut être frustré, moins concentré ou en train de tilter.',
  },
  {
    id: 'hot_streak', category: 'streak', tone: 'strong', title: 'En série (Riot)', example: 'En série',
    rule: 'Indicateur Riot « hotStreak » (3 victoires classées de suite), si l\'historique n\'est pas encore chargé',
    explain: 'Riot signale que ce joueur vient de gagner au moins 3 parties classées d\'affilée. Affiché en attendant que son historique détaillé soit chargé.',
  },
  {
    id: 'good_smite', category: 'playstyle', tone: 'strong', title: 'Bon smite', example: 'Bon smite',
    rule: 'Jungler : a volé au moins 2 objectifs épiques sur ses parties récentes en jungle, plus qu\'il ne s\'en est fait voler',
    explain: 'Ce jungler sécurise bien les objectifs : il vole régulièrement dragons, barons ou hérauts à l\'adversaire. Riot ne publie pas de statistique de smite raté : on mesure les objectifs volés par lui et contre lui.',
  },
  {
    id: 'bad_smite', category: 'playstyle', tone: 'weak', title: 'Mauvais smite', example: 'Mauvais smite',
    rule: 'Jungler : s\'est fait voler au moins 2 objectifs épiques sur ses parties récentes en jungle, plus qu\'il n\'en a volé',
    explain: 'Ce jungler se fait souvent voler ses objectifs (dragon, baron, héraut) : tente le vol au smite. Riot ne publie pas de statistique de smite raté : on mesure les objectifs volés par lui et contre lui.',
  },
  {
    id: 'duelist', category: 'playstyle', tone: 'strong', title: 'Duelliste', example: 'Duelliste',
    rule: 'Au moins 3 solo kills par partie en moyenne (5+ parties) — environ les 15 % de joueurs les plus forts en duel',
    explain: 'Ce joueur gagne souvent ses 1v1 : il tue régulièrement un adversaire seul, sans aide de son équipe. Méfie-toi des duels isolés.',
  },
  {
    id: 'teamfighter', category: 'playstyle', tone: 'strong', title: 'Teamfighter', example: 'Teamfighter',
    rule: 'Participation moyenne aux kills d\'au moins 55 % (5+ parties) — environ les 10-15 % de joueurs les plus présents',
    explain: 'Ce joueur est présent dans la grande majorité des combats de son équipe : il participe à plus de la moitié des kills (la moyenne est autour de 46 %). Très présent en teamfight.',
  },
  {
    id: 'death_prone', category: 'playstyle', tone: 'weak', title: 'Meurt souvent', example: 'Meurt souvent',
    rule: '8 morts ou plus par partie en moyenne (5+ parties) — environ les 15 % de joueurs qui meurent le plus',
    explain: 'Ce joueur meurt beaucoup : il prend des risques ou se fait facilement attraper. Une cible à punir.',
  },
  {
    id: 'main', category: 'champion', tone: 'strong', title: 'Main', example: 'Main',
    rule: 'Entre 40 % et 65 % de ses 8+ dernières parties sur ce champion',
    explain: 'C\'est un de ses champions principaux (« main ») : il le joue très régulièrement, sans en faire un one-trick.',
  },
  {
    id: 'new_champ', category: 'champion', tone: 'weak', title: 'Peu joué', example: 'Peu joué',
    rule: 'Moins de 20 000 points de maîtrise sur ce champion',
    explain: 'Ce joueur a très peu d\'expérience sur ce champion (moins de 20 000 points de maîtrise, soit quelques parties seulement).',
  },
  {
    id: 'off_role', category: 'profile', tone: 'weak', title: 'Autofill', example: 'Autofill',
    rule: 'Le rôle de la partie diffère de son rôle principal (5+ parties analysées)',
    explain: 'Ce joueur ne joue pas son rôle habituel dans cette partie (« autofill ») : il peut être moins à l\'aise. Rôle de la partie estimé, Riot ne le fournit pas en direct.',
  },
  {
    id: 'champ_wr_high', category: 'champion', tone: 'strong', title: 'Gagne avec ce champion', example: 'WR 71 % champ',
    rule: 'Winrate d\'au moins 65 % sur 5+ parties récentes avec ce champion',
    explain: 'Ce joueur gagne très souvent avec ce champion sur ses parties récentes.',
  },
  {
    id: 'champ_wr_low', category: 'champion', tone: 'weak', title: 'Perd avec ce champion', example: 'WR 30 % champ',
    rule: 'Winrate de 35 % ou moins sur 5+ parties récentes avec ce champion',
    explain: 'Ce joueur perd souvent avec ce champion sur ses parties récentes.',
  },
  {
    id: 'champ_kda', category: 'champion', tone: 'strong', title: 'Gros KDA sur ce champion', example: 'KDA 4,8 champ',
    rule: 'KDA de 4 ou plus sur 5+ parties récentes avec ce champion',
    explain: 'Sur ce champion, ce joueur meurt peu et participe beaucoup aux kills : (kills + assists) / morts d\'au moins 4.',
  },
  {
    id: 'in_form', category: 'form', tone: 'strong', title: 'En forme', example: 'En forme · 70 %',
    rule: 'Winrate d\'au moins 65 % sur ses 10+ dernières parties',
    explain: 'Ce joueur gagne nettement plus qu\'il ne perd ces derniers temps, tous champions confondus.',
  },
  {
    id: 'struggling', category: 'form', tone: 'weak', title: 'En difficulté', example: 'En difficulté · 30 %',
    rule: 'Winrate de 35 % ou moins sur ses 10+ dernières parties',
    explain: 'Ce joueur perd nettement plus qu\'il ne gagne ces derniers temps, tous champions confondus.',
  },
  {
    id: 'fresh_blood', category: 'profile', tone: 'info', title: 'Nouveau palier', example: 'Nouveau Diamant',
    rule: 'Récemment arrivé dans son palier : division IV (la première du palier) et indicateur Riot « freshBlood »',
    explain: 'Ce joueur vient d\'atteindre son palier actuel (par exemple tout juste passé d\'Émeraude à Diamant) : il découvre ce niveau de jeu. Un simple passage de division dans le même palier (Émeraude II → I) ne compte pas.',
  },
  {
    id: 'low_games', category: 'profile', tone: 'info', title: 'Peu de parties classées', example: '12 classées',
    rule: 'Moins de 30 parties classées cette saison',
    explain: 'Ce joueur a joué peu de parties classées cette saison : son rang affiché est encore peu représentatif de son vrai niveau.',
  },
  {
    id: 'veteran', category: 'profile', tone: 'info', title: 'Vétéran', example: 'Vétéran',
    rule: 'Indicateur Riot « veteran » : beaucoup de parties dans cette division',
    explain: 'Ce joueur a joué beaucoup de parties dans sa division actuelle (au moins une centaine) : il connaît bien ce niveau mais y stagne. Indicateur fourni par Riot.',
  },
];

/** Jusqu'à 6 repères par joueur, sur une ligne dédiée en bas de sa carte. */
export const MAX_TAGS = 6;
/** Nombre maximal de repères par famille (variété de la ligne). */
const MAX_PER_CATEGORY: Record<TagCategory, number> = { champion: 2, playstyle: 2, streak: 1, form: 1, profile: 1 };

/** Part minimale des parties récentes sur le champion pour « OTP » (proposée par l'utilisateur : 65-70 %). */
export const OTP_SHARE = 0.65;
const MAIN_SHARE = 0.4;
const MIN_GAMES_FOR_SHARE = 8;

export interface TagInput {
  isPlayer: boolean; // false pour un bot ou un joueur masqué
  championName?: string;
  rank: { tier: string; division: string; wins: number; losses: number; hotStreak: boolean; veteran: boolean; freshBlood: boolean } | null;
  masteryLoaded: boolean;
  masteryPoints: number | null; // null = jamais joué (404 Riot)
  recent: {
    games: number;
    winrate: number | null;
    streak: { result: 'W' | 'L'; count: number } | null;
    onChampion: { games: number; winrate: number | null; kda: number | null } | null;
    mainRole: string | null;
    avgDeaths?: number;
    avgSoloKills?: number | null;
    avgKillParticipation?: number | null;
    jungle?: { games: number; steals: number; stolenFrom: number } | null;
  } | null;
  /** Rôle de la partie (déduit). */
  position: string | null;
}

const ROLE_LABELS: Record<string, string> = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };

/** 1 919 463 → « 1,9 M » ; 950 000 → « 950 k ». */
export function formatPoints(points: number): string {
  if (points >= 1_000_000) return `${(points / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (points >= 1_000) return `${Math.round(points / 1_000)} k`;
  return String(points);
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/** Tous les repères applicables, dans l'ordre de priorité du catalogue. */
export function candidateTags(i: TagInput): Tag[] {
  if (!i.isPlayer) return [];
  const found = new Map<TagId, { label: string; hint: string }>();
  const r = i.recent;
  const champ = r?.onChampion ?? null;
  const onThis = i.championName ? `sur ${i.championName}` : 'sur ce champion';
  const mastery = i.masteryPoints !== null ? ` · ${formatPoints(i.masteryPoints)} points de maîtrise` : '';

  const share = r && champ && r.games >= MIN_GAMES_FOR_SHARE ? champ.games / r.games : null;
  if (share !== null && share >= OTP_SHARE) {
    found.set('otp', { label: 'OTP', hint: `${champ!.games} de ses ${r!.games} dernières parties ${onThis} (${pct(share)})${mastery}` });
  } else if (share !== null && share >= MAIN_SHARE) {
    found.set('main', { label: 'Main', hint: `${champ!.games} de ses ${r!.games} dernières parties ${onThis} (${pct(share)})${mastery}` });
  }

  if (i.masteryLoaded && i.masteryPoints === null) {
    found.set('first_time', { label: '1re fois', hint: `0 point de maîtrise ${onThis}` });
  } else if (i.masteryPoints !== null && i.masteryPoints < 20_000) {
    found.set('new_champ', { label: 'Peu joué', hint: `${formatPoints(i.masteryPoints)} points de maîtrise ${onThis}` });
  }

  if (r?.streak && r.streak.count >= 3) {
    const n = r.streak.count;
    if (r.streak.result === 'W') found.set('win_streak', { label: `${n} V d'affilée`, hint: `${n} victoires de suite sur ses dernières parties` });
    else found.set('loss_streak', { label: `${n} D d'affilée`, hint: `${n} défaites de suite sur ses dernières parties` });
  } else if (!r && i.rank?.hotStreak) {
    found.set('hot_streak', { label: 'En série', hint: '3 victoires classées de suite ou plus' });
  }

  if (r && r.games >= 5 && r.mainRole && i.position && r.mainRole !== i.position) {
    const main = ROLE_LABELS[r.mainRole] ?? r.mainRole;
    const now = ROLE_LABELS[i.position] ?? i.position;
    found.set('off_role', { label: 'Autofill', hint: `Joue surtout ${main} ; ici en ${now}` });
  }

  if (champ && champ.games >= 5) {
    if (champ.winrate !== null && champ.winrate >= 0.65) {
      found.set('champ_wr_high', { label: `WR ${pct(champ.winrate)} champ`, hint: `${pct(champ.winrate)} de victoires sur ${champ.games} parties récentes ${onThis}` });
    } else if (champ.winrate !== null && champ.winrate <= 0.35) {
      found.set('champ_wr_low', { label: `WR ${pct(champ.winrate)} champ`, hint: `${pct(champ.winrate)} de victoires sur ${champ.games} parties récentes ${onThis}` });
    }
    if (champ.kda !== null && champ.kda >= 4) {
      const kda = champ.kda.toFixed(1).replace('.', ',');
      found.set('champ_kda', { label: `KDA ${kda} champ`, hint: `KDA moyen de ${kda} sur ${champ.games} parties récentes ${onThis}` });
    }
  }

  // Style de jeu (moyennes sur ses 5+ dernières parties)
  if (r && r.games >= 5) {
    const num = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
    if (r.avgSoloKills != null && r.avgSoloKills >= 3) {
      found.set('duelist', { label: 'Duelliste', hint: `${num(r.avgSoloKills)} solo kills par partie en moyenne` });
    }
    if (r.avgKillParticipation != null && r.avgKillParticipation >= 0.55) {
      found.set('teamfighter', { label: 'Teamfighter', hint: `${pct(r.avgKillParticipation)} de participation aux kills en moyenne` });
    }
    if (r.avgDeaths != null && r.avgDeaths >= 8) {
      found.set('death_prone', { label: 'Meurt souvent', hint: `${num(r.avgDeaths)} morts par partie en moyenne` });
    }
  }
  // Smite : seulement pour le jungler de la partie, sur 3+ parties récentes en jungle.
  const jg = r?.jungle;
  if (i.position === 'JUNGLE' && jg && jg.games >= 3) {
    const detail = `Sur ${jg.games} parties en jungle : ${jg.steals} objectif(s) volé(s), ${jg.stolenFrom} perdu(s) au vol`;
    if (jg.steals >= 2 && jg.steals > jg.stolenFrom) found.set('good_smite', { label: 'Bon smite', hint: detail });
    else if (jg.stolenFrom >= 2 && jg.stolenFrom > jg.steals) found.set('bad_smite', { label: 'Mauvais smite', hint: detail });
  }

  // La forme générale n'apporte rien si une série est déjà signalée.
  const hasStreak = found.has('win_streak') || found.has('loss_streak');
  if (r && r.games >= 10 && r.winrate !== null && !hasStreak) {
    if (r.winrate >= 0.65) found.set('in_form', { label: `En forme · ${pct(r.winrate)}`, hint: `${pct(r.winrate)} de victoires sur ses ${r.games} dernières parties` });
    else if (r.winrate <= 0.35) found.set('struggling', { label: `En difficulté · ${pct(r.winrate)}`, hint: `${pct(r.winrate)} de victoires sur ses ${r.games} dernières parties` });
  }

  if (i.rank) {
    const total = i.rank.wins + i.rank.losses;
    // Nouveau dans le PALIER, pas une simple division : première division du palier + indicateur Riot.
    // Master, Grandmaster et Challenger n'ont pas de divisions : l'indicateur Riot suffit.
    const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(i.rank.tier.toUpperCase());
    if (i.rank.freshBlood && (apex || i.rank.division.toUpperCase() === 'IV')) {
      const tier = tierLabel(i.rank.tier);
      found.set('fresh_blood', { label: `Nouveau ${tier}`, hint: `Vient d'arriver en ${tier}` });
    }
    if (total < 30) found.set('low_games', { label: `${total} classées`, hint: `${total} parties classées cette saison (${i.rank.wins} V / ${i.rank.losses} D)` });
    if (i.rank.veteran) found.set('veteran', { label: 'Vétéran', hint: `${total} parties classées cette saison` });
  }

  return TAG_CATALOG.filter((c) => found.has(c.id)).map((c) => ({
    id: c.id,
    category: c.category,
    tone: c.tone,
    title: c.title,
    explain: c.explain,
    ...found.get(c.id)!,
  }));
}

/**
 * Les repères affichés : ordre de priorité du catalogue, au plus MAX_TAGS, et au plus
 * MAX_PER_CATEGORY par famille, pour garder une ligne variée et lisible.
 */
export function computeTags(i: TagInput): Tag[] {
  const perCategory = new Map<TagCategory, number>();
  const out: Tag[] = [];
  for (const t of candidateTags(i)) {
    const n = perCategory.get(t.category) ?? 0;
    if (n >= MAX_PER_CATEGORY[t.category]) continue;
    perCategory.set(t.category, n + 1);
    out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}
