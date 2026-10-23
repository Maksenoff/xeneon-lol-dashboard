import { describe, expect, it } from 'vitest';
import { candidateTags, computeTags, TAG_CATALOG, type TagInput } from '../../src/domain/tags.js';

const base: TagInput = {
  isPlayer: true,
  championName: 'Vayne',
  rank: { tier: 'EMERALD', division: 'II', wins: 60, losses: 50, hotStreak: false, veteran: false, freshBlood: false },
  masteryLoaded: true,
  masteryPoints: 50_000,
  recent: { games: 20, winrate: 0.5, streak: { result: 'W', count: 1 }, onChampion: { games: 2, winrate: 0.5, kda: 2 }, mainRole: 'BOTTOM' },
  position: 'BOTTOM',
};
const ids = (i: Partial<TagInput>) => candidateTags({ ...base, ...i }).map((t) => t.id);
const recentOn = (games: number, onChamp: number) => ({ ...base.recent!, games, onChampion: { games: onChamp, winrate: 0.5, kda: 2 } });

describe('repères en partie', () => {
  it('aucun repère pour un joueur moyen', () => {
    expect(ids({})).toEqual([]);
  });

  it('OTP seulement si 65 % ou plus des parties récentes sont sur ce champion', () => {
    const [t] = candidateTags({ ...base, masteryPoints: 1_919_463, recent: recentOn(20, 14) });
    expect(t).toMatchObject({
      id: 'otp',
      label: 'OTP',
      tone: 'elite',
      title: 'One-trick (OTP)',
      hint: '14 de ses 20 dernières parties sur Vayne (70 %) · 1,9 M points de maîtrise',
    });
    expect(ids({ masteryPoints: 1_919_463, recent: recentOn(20, 12) })).not.toContain('otp'); // 60 % → Spécialiste
    expect(ids({ masteryPoints: 1_919_463, recent: recentOn(20, 12) })).toContain('main');
    expect(ids({ masteryPoints: 1_919_463 })).not.toContain('otp'); // beaucoup de maîtrise ne suffit plus
    expect(ids({ recent: recentOn(6, 6) })).not.toContain('otp'); // moins de 8 parties analysées
  });

  it('1re fois si aucune maîtrise, Peu joué sous 20 k', () => {
    expect(ids({ masteryPoints: null })).toContain('first_time');
    expect(ids({ masteryPoints: 8_000 })).toContain('new_champ');
    expect(ids({ masteryPoints: null, masteryLoaded: false })).not.toContain('first_time'); // pas encore chargé
  });

  it('séries de 3+ et forme générale (masquée si une série est affichée)', () => {
    expect(ids({ recent: { ...base.recent!, streak: { result: 'L', count: 4 }, winrate: 0.3 } })).toEqual(['loss_streak']);
    expect(ids({ recent: { ...base.recent!, winrate: 0.7 } })).toEqual(['in_form']);
    expect(ids({ recent: { ...base.recent!, winrate: 0.3 } })).toEqual(['struggling']);
  });

  it('main (40-65 %), winrate et KDA sur le champion', () => {
    const r = { ...base.recent!, games: 10, onChampion: { games: 5, winrate: 0.8, kda: 4.8 } };
    expect(ids({ recent: r })).toEqual(['main', 'champ_wr_high', 'champ_kda']);
  });

  it('autofill quand le rôle de la partie diffère du rôle principal', () => {
    const [t] = candidateTags({ ...base, position: 'UTILITY', recent: { ...base.recent!, mainRole: 'MIDDLE' } });
    expect(t).toMatchObject({ id: 'off_role', label: 'Autofill', title: 'Autofill', hint: 'Joue surtout Mid ; ici en Support', tone: 'weak' });
  });

  it('duelliste, teamfighter et meurt souvent (moyennes sur 5+ parties)', () => {
    const r = { ...base.recent!, avgSoloKills: 3.4, avgKillParticipation: 0.58, avgDeaths: 8.5 };
    const tags = candidateTags({ ...base, recent: r });
    expect(tags.map((t) => t.id)).toEqual(['duelist', 'teamfighter', 'death_prone']);
    expect(tags[0]!.hint).toBe('3,4 solo kills par partie en moyenne');
    expect(tags[1]!.hint).toBe('58 % de participation aux kills en moyenne');
    expect(tags[2]!.hint).toBe('8,5 morts par partie en moyenne');
    expect(ids({ recent: { ...r, games: 4 } })).toEqual([]); // pas assez de parties
    expect(ids({ recent: { ...base.recent!, avgSoloKills: 2.5, avgKillParticipation: 0.5, avgDeaths: 7.5 } })).toEqual([]); // sous les seuils (≈ 15 % les plus marqués)
  });

  it('bon / mauvais smite : seulement pour le jungler, sur 3+ parties en jungle', () => {
    const jungler = (steals: number, stolenFrom: number) =>
      candidateTags({ ...base, position: 'JUNGLE', recent: { ...base.recent!, mainRole: 'JUNGLE', jungle: { games: 6, steals, stolenFrom } } });
    expect(jungler(3, 1).map((t) => t.id)).toEqual(['good_smite']);
    expect(jungler(3, 1)[0]!.hint).toBe('Sur 6 parties en jungle : 3 objectif(s) volé(s), 1 perdu(s) au vol');
    expect(jungler(0, 2).map((t) => t.id)).toEqual(['bad_smite']);
    expect(jungler(1, 1)).toEqual([]); // rien de significatif
    // pas jungler dans cette partie → pas de repère smite
    expect(ids({ position: 'TOP', recent: { ...base.recent!, mainRole: 'TOP', jungle: { games: 6, steals: 4, stolenFrom: 0 } } })).toEqual([]);
  });

  it('indicateurs Riot : hotStreak (sans historique), freshBlood, veteran, peu de parties', () => {
    expect(ids({ recent: null, rank: { ...base.rank!, hotStreak: true } })).toContain('hot_streak');
    expect(ids({ rank: { ...base.rank!, division: 'IV', freshBlood: true, veteran: true } })).toEqual(['fresh_blood', 'veteran']);
    const [low] = candidateTags({ ...base, rank: { ...base.rank!, wins: 8, losses: 4 } });
    expect(low).toMatchObject({ id: 'low_games', label: '12 classées', hint: '12 parties classées cette saison (8 V / 4 D)' });
    // Nouveau PALIER seulement : Émeraude IV récent oui, Émeraude II → I non ; apex sans division oui
    const [fresh] = candidateTags({ ...base, rank: { ...base.rank!, tier: 'DIAMOND', division: 'IV', freshBlood: true } });
    expect(fresh).toMatchObject({ id: 'fresh_blood', label: 'Nouveau Diamant', title: 'Nouveau palier', hint: "Vient d'arriver en Diamant" });
    expect(ids({ rank: { ...base.rank!, division: 'I', freshBlood: true } })).not.toContain('fresh_blood');
    expect(ids({ rank: { ...base.rank!, tier: 'MASTER', division: 'I', freshBlood: true } })).toContain('fresh_blood');
  });

  it('rien pour un bot ou un joueur masqué', () => {
    expect(ids({ isPlayer: false, recent: recentOn(20, 18) })).toEqual([]);
  });

  it('affiche au plus 6 repères : 2 « champion », 2 « style de jeu », 1 par autre famille', () => {
    const tags = computeTags({
      ...base,
      position: 'TOP',
      rank: { ...base.rank!, division: 'IV', freshBlood: true, veteran: true },
      recent: {
        games: 12, winrate: 0.75, streak: { result: 'W', count: 5 }, onChampion: { games: 9, winrate: 0.8, kda: 5 }, mainRole: 'BOTTOM',
        avgSoloKills: 3.5, avgKillParticipation: 0.6, avgDeaths: 9,
      },
    });
    expect(tags.map((t) => t.id)).toEqual(['otp', 'win_streak', 'duelist', 'teamfighter', 'off_role', 'champ_wr_high']);
  });

  it('chaque repère du catalogue a un titre, une règle et une explication en clair', () => {
    expect(TAG_CATALOG).toHaveLength(21);
    for (const t of TAG_CATALOG) {
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.rule.length).toBeGreaterThan(10);
      expect(t.explain.length).toBeGreaterThan(40);
    }
  });
});
