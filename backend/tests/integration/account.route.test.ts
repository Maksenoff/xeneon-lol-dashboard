import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { openDb, type Db } from '../../src/db/index.js';
import { jsonResponse, routerFetch, testConfig } from '../helpers.js';

/** Account-V1 simulé : tout compte existe sauf « Inconnu#EUW ». */
const fetchFn = routerFetch((url) => {
  const m = /\/riot\/account\/v1\/accounts\/by-riot-id\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const gameName = decodeURIComponent(m[1]!);
    const tagLine = decodeURIComponent(m[2]!);
    if (gameName === 'Inconnu') return undefined;
    return jsonResponse({ puuid: `PUUID-${gameName}`, gameName, tagLine: tagLine.toUpperCase() });
  }
  if (url.pathname.startsWith('/lol/')) return jsonResponse([]); // league / ids vides
  return undefined;
});

describe('/api/account', () => {
  let app: FastifyInstance;
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    ({ app } = await buildApp({ config: testConfig(), db, fetchFn, logger: false }));
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const post = (riotId: string) =>
    app.inject({ method: 'POST', url: `/api/account?riotId=${encodeURIComponent(riotId)}` });

  it('suit par défaut le compte du .env', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/account' });
    expect(res.json()).toMatchObject({ gameName: 'Maksenoff', tagLine: 'EUW', isDefault: true });
  });

  it('change le compte suivi après vérification chez Riot, et le conserve', async () => {
    const res = await post('Faker Fan#euw');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ puuid: 'PUUID-Faker Fan', gameName: 'Faker Fan', tagLine: 'EUW', isDefault: false });

    expect((await app.inject({ method: 'GET', url: '/api/account' })).json()).toMatchObject({ gameName: 'Faker Fan' });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().riotId).toBe('Faker Fan#EUW');
    // la session suit le nouveau compte
    const session = await app.inject({ method: 'GET', url: '/api/session?period=semaine' });
    expect(session.json().account).toEqual({ gameName: 'Faker Fan', tagLine: 'EUW' });
  });

  it('refuse un format invalide (400) et un compte inexistant (404) sans changer le compte suivi', async () => {
    expect((await post('SansTag')).statusCode).toBe(400);
    expect((await post('Inconnu#EUW')).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/account' })).json()).toMatchObject({ gameName: 'Maksenoff', isDefault: true });
  });

  it('riotId vide → retour au compte du .env', async () => {
    await post('Autre#EUW');
    const res = await post('');
    expect(res.json()).toMatchObject({ gameName: 'Maksenoff', isDefault: true });
  });
});
