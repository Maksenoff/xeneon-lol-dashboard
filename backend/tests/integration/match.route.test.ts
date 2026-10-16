import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/app.js';
import { openDb, type Db } from '../../src/db/index.js';
import type { MatchDetail } from '../../src/services/matchDetail.js';
import { leagueEntry, makeMatch, ME } from '../fixtures/factories.js';
import { jsonResponse, routerFetch, testConfig } from '../helpers.js';

const END = Date.now() - 3600_000;
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

const fetchFn = routerFetch((url) => {
  if (url.pathname.startsWith('/riot/account/v1/')) return jsonResponse({ puuid: ME, gameName: 'Maksenoff', tagLine: 'EUW' });
  if (url.pathname.startsWith('/lol/league/v4/entries/by-puuid/')) {
    const puuid = decodeURIComponent(url.pathname.split('/').pop()!);
    if (puuid.endsWith('-0')) return jsonResponse([]); // un joueur non classé
    return jsonResponse([leagueEntry('RANKED_SOLO_5x5', 'DIAMOND', 'III', 33, 80, 70)]);
  }
  return undefined;
});

describe('GET /api/match/:matchId', () => {
  let app: FastifyInstance;
  let deps: AppDeps;
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    ({ app, deps } = await buildApp({ config: testConfig(), db, fetchFn, logger: false }));

    // Partie de 30 min. Équipe 100 : moi (BOTTOM) + 4 alliés ; équipe 200 : 5 ennemis, rôles complets.
    const dto = makeMatch({ id: 'EUW1_123456', endedAt: END, win: true, durationS: 1800, k: 10, d: 2, a: 8 });
    const [me, ...others] = dto.info.participants;
    Object.assign(me!, {
      totalDamageDealtToChampions: 42_000, totalMinionsKilled: 230, neutralMinionsKilled: 10, goldEarned: 14_000, visionScore: 18,
      totalDamageTaken: 20_000, challenges: { killParticipation: 0.6, laneMinionsFirst10Minutes: 80, goldPerMinute: 466, damagePerMinute: 1400, soloKills: 2 },
    });
    const allies = others.filter((p) => p.teamId === 100);
    const enemies = others.filter((p) => p.teamId === 200);
    ['TOP', 'JUNGLE', 'MIDDLE', 'UTILITY'].forEach((r, i) => Object.assign(allies[i]!, { teamPosition: r }));
    ROLES.forEach((r, i) => Object.assign(enemies[i]!, { teamPosition: r }));
    const opponent = enemies[3]!; // BOTTOM
    Object.assign(opponent, {
      totalMinionsKilled: 260, neutralMinionsKilled: 10, goldEarned: 15_500, totalDamageDealtToChampions: 30_000, kills: 6,
      totalDamageTaken: 25_000, challenges: { killParticipation: 0.4, laneMinionsFirst10Minutes: 85, soloKills: 0 },
    });
    deps.matches.store(dto);

    // Snapshots encadrant la partie : 50 LP avant, 72 LP après → +22 exacts.
    const snap = db.prepare(
      `INSERT INTO rank_snapshots (puuid, queue_type, tier, division, lp, wins, losses, taken_at, trigger) VALUES (?, 'RANKED_SOLO_5x5', 'EMERALD', 'II', ?, ?, 10, ?, 'poll')`,
    );
    snap.run(ME, 50, 10, END - 40 * 60_000);
    snap.run(ME, 72, 11, END + 60_000);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function detail(): Promise<MatchDetail> {
    const res = await app.inject({ method: 'GET', url: '/api/match/EUW1_123456' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  it('renvoie les 10 joueurs triés par rôle, mon équipe d’abord, avec ★, rangs, LP et rang après', async () => {
    const m = await detail();
    expect(m).toMatchObject({ queue: 'Classée Solo/Duo', durationS: 1800, result: 'W', remake: false });
    expect(m.lp).toEqual({ delta: 22, source: 'snapshot' });
    expect(m.rankAfter).toMatchObject({ label: 'Émeraude II', lp: 72, emblem: '/api/assets/rank/emerald.png' });

    expect(m.teams[0]).toMatchObject({ teamId: 100, isMine: true, win: true });
    expect(m.teams[0]!.players.map((p) => p.position)).toEqual(ROLES); // ordre Top → Support
    expect(m.teams[1]!.players.map((p) => p.position)).toEqual(ROLES);

    const me = m.teams[0]!.players.find((p) => p.isMe)!;
    expect(me).toMatchObject({ kills: 10, deaths: 2, assists: 8, kda: 9, cs: 240, csPerMin: 8, damage: 42_000, killParticipation: 0.6 });
    expect(me.badges).toEqual(expect.arrayContaining(['damage', 'kills', 'kda', 'kp']));
    expect(me.badges).not.toContain('cs');
    expect(me.rank).toMatchObject({ label: 'Diamant III', lp: 33, emblem: '/api/assets/rank/diamond.png' });

    const opp = m.teams[1]!.players.find((p) => p.position === 'BOTTOM')!;
    expect(opp.badges).toEqual(expect.arrayContaining(['cs', 'gold']));
    // le joueur « -0 » est non classé
    expect(m.teams.flatMap((t) => t.players).some((p) => p.rank === null)).toBe(true);
  });

  it('calcule les 5 duels de lane avec stats détaillées et vainqueur par stat', async () => {
    const m = await detail();
    expect(m.duels.map((d) => d.position)).toEqual(ROLES);
    const mine = m.duels.find((d) => d.isMine)!;
    expect(mine).toMatchObject({ position: 'BOTTOM', ally: ME, goldDiff: -1_500 });
    // 9 stats lisibles, en 3 groupes
    expect(mine.stats.map((s) => s.id)).toEqual(['kda', 'damage', 'kp', 'csPerMin', 'cs10', 'gold', 'vision', 'buildings', 'soloKills']);
    expect([...new Set(mine.stats.map((s) => s.group))]).toEqual(['combat', 'farm', 'map']);
    expect(m.duelGroupLabels).toEqual({ combat: 'Combat', farm: 'Farm & or', map: 'Carte' });
    const stat = (id: string) => mine.stats.find((s) => s.id === id)!;
    expect(stat('damage')).toMatchObject({ ally: 42_000, enemy: 30_000, winner: 'ally', diff: 12_000 });
    expect(stat('damage').advantage).toBeCloseTo(12_000 / 42_000, 3);
    expect(stat('csPerMin')).toMatchObject({ ally: 8, enemy: 9, winner: 'enemy', diff: -1 });
    expect(stat('cs10')).toMatchObject({ ally: 80, enemy: 85, winner: 'enemy' });
    expect(stat('soloKills')).toMatchObject({ ally: 2, enemy: 0, winner: 'ally', advantage: 1 });
  });

  it('404 pour une partie inconnue, 400 pour un identifiant invalide', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/match/EUW1_999999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/match/..%2Fetc' })).statusCode).toBe(400);
  });
});
