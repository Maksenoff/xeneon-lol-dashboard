import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { openDb, type Db } from '../../src/db/index.js';
import type { SessionSummary } from '../../src/services/sessionService.js';
import type { LeagueEntryDto, MatchDto } from '../../src/riot/types.js';
import { leagueEntry, makeMatch, ME, type MatchSpec } from '../fixtures/factories.js';
import { jsonResponse, routerFetch, testConfig } from '../helpers.js';

const MIN = 60_000;
// Jeudi 15/10/2026, 18:00 heure de Paris
const T0 = Date.parse('2026-10-15T16:00:00Z');

/** Faux Riot avec état : historique de parties + entrée League-V4 modifiables au fil du test. */
function fakeRiot() {
  const matches = new Map<string, MatchDto>();
  const state: { solo: LeagueEntryDto | null } = { solo: leagueEntry('RANKED_SOLO_5x5', 'EMERALD', 'II', 50, 10, 10) };

  const fetchFn = routerFetch((url) => {
    const p = url.pathname;
    if (p.startsWith('/riot/account/v1/accounts/by-riot-id/')) {
      return jsonResponse({ puuid: ME, gameName: 'Maksenoff', tagLine: 'EUW' });
    }
    if (p.endsWith('/ids')) {
      const startTime = Number(url.searchParams.get('startTime') ?? 0) * 1000;
      const start = Number(url.searchParams.get('start') ?? 0);
      const count = Number(url.searchParams.get('count') ?? 20);
      const ids = [...matches.values()]
        .filter((m) => m.info.gameStartTimestamp >= startTime)
        .sort((a, b) => b.info.gameStartTimestamp - a.info.gameStartTimestamp)
        .map((m) => m.metadata.matchId)
        .slice(start, start + count);
      return jsonResponse(ids);
    }
    const matchId = /\/lol\/match\/v5\/matches\/([^/]+)$/.exec(p)?.[1];
    if (matchId) {
      const m = matches.get(matchId);
      return m ? jsonResponse(m) : undefined;
    }
    if (p.endsWith('/by-champion/67')) {
      return jsonResponse({ championId: 67, championLevel: 48, championPoints: 912_345, lastPlayTime: T0 });
    }
    if (p.startsWith('/lol/league/v4/entries/by-puuid/')) {
      return jsonResponse([state.solo, leagueEntry('RANKED_PREMADE_5x5', 'DIAMOND', 'IV', 67, 10, 10)].filter(Boolean));
    }
    return undefined;
  });

  return {
    fetchFn,
    state,
    addMatch: (spec: MatchSpec) => matches.set(spec.id, makeMatch(spec)),
  };
}

describe('Session : /api/session', () => {
  let app: FastifyInstance;
  let db: Db;
  let riot: ReturnType<typeof fakeRiot>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    db = openDb(':memory:');
    riot = fakeRiot();
    // Historique antérieur : une classée gagnée ce midi (avant tout snapshot), un ARAM hier.
    riot.addMatch({ id: 'EUW1_OLDWIN', endedAt: T0 - 6 * 60 * MIN, win: true, champion: 'Jinx', championId: 222 });
    riot.addMatch({ id: 'EUW1_ARAM', endedAt: T0 - 26 * 60 * MIN, win: false, queueId: 450, champion: 'Lux' });
    ({ app } = await buildApp({ config: testConfig(), db, fetchFn: riot.fetchFn, logger: false }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    db.close();
  });

  async function get(qs = ''): Promise<SessionSummary> {
    const res = await app.inject({ method: 'GET', url: `/api/session${qs}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  function advanceTo(t: number) {
    vi.setSystemTime(t);
  }

  it('déroule une session complète : W puis LL, séries, LP exacts puis estimés', async () => {
    // 1) Pas encore de session
    const empty = await get();
    expect(empty.session).toBeNull();
    expect(empty.summary.games).toBe(0);
    expect(empty.matches).toEqual([]);

    // 2) Bouton « Démarrer la session »
    advanceTo(T0 + MIN);
    const started = await app.inject({ method: 'POST', url: '/api/session/start' });
    expect(started.statusCode).toBe(201);
    expect(started.json().session.endedAt).toBeNull();

    // 3) Une victoire : +22 LP exacts
    riot.addMatch({ id: 'EUW1_G1', endedAt: T0 + 30 * MIN, win: true, k: 10, d: 5, a: 8 });
    riot.state.solo = leagueEntry('RANKED_SOLO_5x5', 'EMERALD', 'II', 72, 11, 10);
    advanceTo(T0 + 40 * MIN);
    const s1 = await get('?mode=rsolo&period=session');
    expect(s1.summary).toMatchObject({ games: 1, wins: 1, losses: 0, winrate: 1, kda: 3.6, avgKills: 10, avgDeaths: 5, avgAssists: 8 });
    expect(s1.lp).toEqual({ net: 22, source: 'snapshot', adjustments: 0 });
    expect(s1.matches[0]).toMatchObject({
      matchId: 'EUW1_G1',
      result: 'W',
      champion: { id: 67, name: 'Vayne' },
      lpDelta: 22,
      lpSource: 'snapshot',
      queue: 'Classée Solo/Duo',
    });
    expect(s1.streak.current).toEqual({ result: 'W', count: 2 }); // OLDWIN + G1
    expect(s1.rank).toMatchObject({ label: 'Émeraude II', lp: 72, atPeriodStart: { label: 'Émeraude II', lp: 50 } });

    // 4) Deux défaites entre deux snapshots : total exact (-37), répartition estimée
    riot.addMatch({ id: 'EUW1_G2', endedAt: T0 + 70 * MIN, win: false });
    riot.addMatch({ id: 'EUW1_G3', endedAt: T0 + 105 * MIN, win: false });
    riot.state.solo = leagueEntry('RANKED_SOLO_5x5', 'EMERALD', 'II', 35, 11, 12);
    advanceTo(T0 + 120 * MIN);
    const s2 = await get('?mode=rsolo&period=session');
    expect(s2.summary).toMatchObject({ games: 3, wins: 1, losses: 2 });
    expect(s2.streak).toMatchObject({ current: { result: 'L', count: 2 }, sequence: 'WLL', longestLossInPeriod: 2 });
    expect(s2.lp).toEqual({ net: -15, source: 'estimated', adjustments: 0 });
    expect(s2.matches.map((m) => m.matchId)).toEqual(['EUW1_G3', 'EUW1_G2', 'EUW1_G1']);
    expect(s2.matches[0]!.lpSource).toBe('estimated');
    expect(s2.matches[0]!.lpDelta! + s2.matches[1]!.lpDelta!).toBe(-37);

    // 5) Période « jour » : inclut la victoire de midi, LP approximatif (médiane des gains exacts = 22)
    const day = await get('?mode=rsolo&period=jour');
    expect(day.summary.games).toBe(4);
    expect(day.matches.at(-1)).toMatchObject({ matchId: 'EUW1_OLDWIN', lpDelta: 22, lpSource: 'estimated' });
    expect(day.lp).toEqual({ net: 7, source: 'estimated', adjustments: 0 });

    // Top champions : Vayne (3 parties) puis Jinx (1), avec la maîtrise du compte
    expect(day.topChampions.map((c) => c.champion.name)).toEqual(['Vayne', 'Jinx']);
    expect(day.topChampions[0]).toMatchObject({
      games: 3,
      wins: 1,
      losses: 2,
      winrate: 0.333,
      avgKills: 10,
      avgCs: 160,
      lpNet: -15,
      lpSource: 'estimated',
      mastery: { level: 48, points: 912_345 },
    });
    expect(day.topChampions[1]!.mastery).toBeNull(); // 404 Riot → pas de maîtrise
    expect(day.summary.avgCs).toBe(160);

    // 6) Remake : affiché mais hors W/L et sans LP
    riot.addMatch({ id: 'EUW1_REMAKE', endedAt: T0 + 130 * MIN, win: false, remake: true });
    advanceTo(T0 + 135 * MIN);
    const s3 = await get('?mode=rsolo&period=session');
    expect(s3.summary).toMatchObject({ games: 3, remakes: 1 });
    expect(s3.matches[0]).toMatchObject({ matchId: 'EUW1_REMAKE', result: 'REMAKE', lpDelta: 0 });
    expect(s3.streak.sequence).toBe('WLL');

    // 7) Fin de session
    const stopped = await app.inject({ method: 'POST', url: '/api/session/stop' });
    expect(stopped.json().session.endedAt).not.toBeNull();
    expect((await get()).session).toBeNull();
  });

  it('filtre par mode : ARAM sans LP, rang Solo/Duo en référence', async () => {
    const aram = await get('?mode=aram&period=semaine');
    expect(aram.summary.games).toBe(1);
    expect(aram.matches[0]).toMatchObject({ matchId: 'EUW1_ARAM', queue: 'ARAM', result: 'L', lpDelta: null, lpSource: null });
    expect(aram.lp).toBeNull();
    expect(aram.rank).toMatchObject({ queueType: 'RANKED_SOLO_5x5', label: 'Émeraude II', emblem: '/api/assets/rank/emerald.png' });
  });

  it('mode all : toutes les files', async () => {
    const all = await get('?mode=all&period=semaine');
    expect(all.matches.map((m) => m.matchId)).toEqual(['EUW1_OLDWIN', 'EUW1_ARAM']);
  });

  it('stocke les 10 joueurs de chaque partie', async () => {
    await get('?period=semaine');
    const n = db.prepare('SELECT COUNT(*) AS n FROM match_participants WHERE match_id = ?').get('EUW1_OLDWIN') as { n: number };
    expect(n.n).toBe(10);
  });

  it('refuse un mode ou une période inconnus (400)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/session?mode=urf' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/session?period=mois' })).statusCode).toBe(400);
  });

  it('n’attend pas Riot plus de 5 s : répond avec les données stockées', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: T0 });
    await app.close();
    db.close();
    db = openDb(':memory:');
    const hanging = vi.fn(() => new Promise<Response>(() => {}));
    ({ app } = await buildApp({ config: testConfig(), db, fetchFn: hanging as unknown as typeof fetch, logger: false }));
    // le compte doit déjà être connu pour que la route ne bloque pas sur Account-V1
    db.prepare('INSERT INTO http_cache (key, status, body, fetched_at, expires_at) VALUES (?, 200, ?, ?, NULL)').run(
      'https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Maksenoff/EUW',
      JSON.stringify({ puuid: ME, gameName: 'Maksenoff', tagLine: 'EUW' }),
      T0,
    );
    const pending = app.inject({ method: 'GET', url: '/api/session?period=semaine' });
    await vi.advanceTimersByTimeAsync(5_100);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.games).toBe(0);
  });
});
