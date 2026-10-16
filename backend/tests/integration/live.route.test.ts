import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { openDb, type Db } from '../../src/db/index.js';
import type { LiveGameView } from '../../src/services/liveService.js';
import type { CurrentGameInfo } from '../../src/riot/endpoints/spectator.js';
import type { LiveAllGameData } from '../../src/liveclient/liveClient.js';
import { leagueEntry, makeMatch, ME } from '../fixtures/factories.js';
import { jsonResponse, routerFetch, testConfig } from '../helpers.js';

/** Partie simulée au format CurrentGameInfo (doc Spectator-V5). Moi = équipe 200. */
function currentGame(): CurrentGameInfo {
  const others = Array.from({ length: 9 }, (_, i) => ({
    puuid: `P${i}`,
    riotId: `Joueur${i}#EUW`,
    championId: 100 + i,
    teamId: i < 5 ? 100 : 200,
    spell1Id: 4,
    spell2Id: 7,
    bot: false,
  }));
  others[1]!.spell1Id = 11; // P1 a Châtiment → jungle
  others[8]!.puuid = null; // joueur masqué (mode streamer)
  others[8]!.riotId = '';
  return {
    gameId: 777,
    gameQueueConfigId: 420,
    gameMode: 'CLASSIC',
    gameStartTime: Date.now() - 5 * 60_000,
    gameLength: 300,
    participants: [{ puuid: ME, riotId: 'Maksenoff#EUW', championId: 67, teamId: 200, bot: false }, ...others],
    bannedChampions: [{ championId: 157, teamId: 100, pickTurn: 1 }, { championId: -1, teamId: 200, pickTurn: 2 }],
  };
}

function fakeRiot(inGame: { value: boolean }) {
  // Historique : P0 a 6 victoires d'affilée sur le champion 100 ; moi : 3 défaites.
  const histories: Record<string, Array<{ win: boolean; champ: number }>> = {
    P0: Array.from({ length: 6 }, () => ({ win: true, champ: 100 })),
    [ME]: [{ win: false, champ: 67 }, { win: false, champ: 67 }, { win: false, champ: 67 }],
  };
  const matches = new Map<string, ReturnType<typeof makeMatch>>();
  const idsByPlayer: Record<string, string[]> = {};
  for (const [puuid, games] of Object.entries(histories)) {
    idsByPlayer[puuid] = games.map((g, i) => {
      const id = `EUW1_${puuid}_${i}`;
      const m = makeMatch({ id, endedAt: Date.now() - (i + 1) * 3600_000, win: g.win, championId: g.champ });
      // makeMatch place ME comme joueur principal : on remplace son puuid par celui de l'historique.
      m.info.participants[0]!.puuid = puuid;
      matches.set(id, m);
      return id;
    });
  }

  return routerFetch((url) => {
    const p = url.pathname;
    if (p.startsWith('/riot/account/v1/')) return jsonResponse({ puuid: ME, gameName: 'Maksenoff', tagLine: 'EUW' });
    if (p.startsWith('/lol/spectator/v5/active-games/by-summoner/')) return inGame.value ? jsonResponse(currentGame()) : undefined;
    if (p.startsWith('/lol/league/v4/entries/by-puuid/')) {
      const puuid = decodeURIComponent(p.split('/').pop()!);
      if (puuid === 'P1') return jsonResponse([]); // non classé
      if (puuid === 'P0') return jsonResponse([{ ...leagueEntry('RANKED_SOLO_5x5', 'DIAMOND', 'IV', 40, 60, 40), hotStreak: true }]);
      return jsonResponse([leagueEntry('RANKED_SOLO_5x5', 'EMERALD', 'II', 50, 50, 50)]);
    }
    if (p.includes('/champion-masteries/by-puuid/')) {
      // /lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}/by-champion/{id}
      const puuid = decodeURIComponent(p.split('/')[6]!);
      if (puuid === 'P2') return undefined; // jamais joué → 404
      if (puuid === ME) return jsonResponse({ championId: 67, championLevel: 50, championPoints: 950_000, lastPlayTime: Date.now() });
      return jsonResponse({ championId: 1, championLevel: 10, championPoints: 60_000, lastPlayTime: Date.now() });
    }
    if (p.endsWith('/ids')) {
      const puuid = decodeURIComponent(p.split('/')[6]!);
      return jsonResponse(idsByPlayer[puuid] ?? []);
    }
    const matchId = /\/lol\/match\/v5\/matches\/([^/]+)$/.exec(p)?.[1];
    if (matchId) return matches.has(matchId) ? jsonResponse(matches.get(matchId)) : undefined;
    return undefined;
  });
}

const liveClientData: LiveAllGameData = {
  gameData: { gameTime: 301.7 },
  allPlayers: [{ riotId: 'Maksenoff#EUW', team: 'CHAOS', level: 6, scores: { kills: 2, deaths: 0, assists: 1, creepScore: 48 } }],
};

describe('GET /api/live', () => {
  let app: FastifyInstance;
  let db: Db;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function setup(inGame: { value: boolean }) {
    db = openDb(':memory:');
    ({ app } = await buildApp({
      config: testConfig(),
      db,
      fetchFn: fakeRiot(inGame),
      logger: false,
      liveClient: { allGameData: async () => (inGame.value ? liveClientData : null) },
    }));
  }

  async function live(): Promise<LiveGameView | null> {
    const res = await app.inject({ method: 'GET', url: '/api/live' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().game;
  }

  async function untilComplete(): Promise<LiveGameView> {
    for (let i = 0; i < 100; i++) {
      const g = await live();
      if (g?.status === 'complete') return g;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('analyse jamais terminée');
  }

  it('renvoie { game: null } hors partie', async () => {
    await setup({ value: false });
    expect(await live()).toBeNull();
  });

  it('détecte la partie, met mon équipe en premier et enrichit progressivement les joueurs', async () => {
    await setup({ value: true });
    const first = (await live())!;
    expect(first.gameId).toBe(777);
    expect(first.queue).toBe('Classée Solo/Duo');
    expect(first.teams[0]!).toMatchObject({ teamId: 200, isMine: true, side: 'red' });
    expect(first.teams[1]!).toMatchObject({ teamId: 100, isMine: false, side: 'blue' });
    expect(first.teams.flatMap((t) => t.players)).toHaveLength(10);
    expect(first.bans).toEqual([{ championId: 157, teamId: 100, icon: '/api/assets/champion/157.png' }]);

    const g = await untilComplete();
    expect(g.progress.done).toBe(g.progress.total);
    expect(g.sources.liveClient).toBe(true);
    expect(g.gameTimeS).toBe(302);

    const me = g.teams[0]!.players.find((p) => p.isMe)!;
    expect(me).toMatchObject({ riotId: 'Maksenoff#EUW', gameName: 'Maksenoff' });
    expect(me.rank).toMatchObject({ label: 'Émeraude II', lp: 50, emblem: '/api/assets/rank/emerald.png' });
    expect(me.mastery).toMatchObject({ level: 50, points: 950_000 });
    expect(me.recent).toMatchObject({ games: 3, wins: 0, last5: ['L', 'L', 'L'], streak: { result: 'L', count: 3 } });
    expect(me.live).toEqual({ kills: 2, deaths: 0, assists: 1, cs: 48, level: 6 });
    expect(me.tags.map((t) => t.id)).toEqual(['loss_streak', 'otp']);

    const enemies = g.teams[1]!.players;
    const p0 = enemies.find((p) => p.puuid === 'P0')!;
    expect(p0.rank).toMatchObject({ label: 'Diamant IV', hotStreak: true, winrate: 0.6 });
    expect(p0.recent).toMatchObject({ games: 6, winrate: 1, onChampion: { games: 6, wins: 6, winrate: 1 } });
    expect(p0.tags.map((t) => t.id)).toContain('win_streak');
    expect(p0.tags.map((t) => t.id)).toContain('champ_wr_high');

    expect(enemies.find((p) => p.puuid === 'P1')!.rank).toBeNull(); // non classé
    const p2 = enemies.find((p) => p.puuid === 'P2')!;
    expect(p2.mastery).toBeNull();
    expect(p2.tags.map((t) => t.id)).toContain('new_champ');

    const hidden = g.teams[0]!.players.find((p) => p.puuid === null)!;
    expect(hidden).toMatchObject({ riotId: 'Joueur masqué', rank: null, recent: null, tags: [] });

    expect(g.teams[1]!.avgRank).not.toBeNull();

    // Rôles déduits : 5 rôles distincts par équipe, triés Top → Support
    for (const t of g.teams) {
      expect(t.players.map((p) => p.position)).toEqual(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']);
    }
    expect(me).toMatchObject({ position: 'BOTTOM', positionSource: 'inferred' }); // historique : ADC
    expect(p0.position).toBe('BOTTOM');
    expect(enemies.find((p) => p.puuid === 'P1')!.position).toBe('JUNGLE'); // Châtiment
    expect(me.tags.find((t) => t.id === 'otp')!.label).toBe('OTP · 950 k');
  });

  it('repasse à null quand la partie se termine', async () => {
    const inGame = { value: true };
    await setup(inGame);
    expect(await live()).not.toBeNull();
    inGame.value = false;
    // le cache Spectator dure 15 s : on le vide pour simuler l'expiration
    db.prepare("DELETE FROM http_cache WHERE key LIKE '%spectator%'").run();
    expect(await live()).toBeNull();
  });
});
