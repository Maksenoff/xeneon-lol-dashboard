import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import account from '../fixtures/account-v1.by-riot-id.json' with { type: 'json' };
import { buildApp } from '../../src/app.js';
import { openDb, type Db } from '../../src/db/index.js';
import { jsonResponse, sequenceFetch, testConfig } from '../helpers.js';

describe('GET /api/debug/account', () => {
  let app: FastifyInstance;
  let db: Db;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function setup(fetchFn: typeof fetch) {
    db = openDb(':memory:');
    ({ app } = await buildApp({ config: testConfig(), db, fetchFn, logger: false }));
  }

  it('résout Maksenoff#EUW en PUUID via Account-V1 (europe) et le stocke', async () => {
    const fetchFn = sequenceFetch(jsonResponse(account));
    await setup(fetchFn);

    const res = await app.inject({ method: 'GET', url: '/api/debug/account' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ puuid: account.puuid, gameName: 'Maksenoff', tagLine: 'EUW' });

    expect(String(fetchFn.mock.calls[0]![0])).toBe(
      'https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Maksenoff/EUW',
    );
    const row = db.prepare('SELECT game_name FROM accounts WHERE puuid = ?').get(account.puuid);
    expect(row).toEqual({ game_name: 'Maksenoff' });

    // 2e appel : servi par le cache, pas de nouvelle requête Riot
    await app.inject({ method: 'GET', url: '/api/debug/account' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('renvoie 404 si le compte n’existe pas', async () => {
    await setup(sequenceFetch(jsonResponse({ status: { status_code: 404 } }, 404)));
    const res = await app.inject({ method: 'GET', url: '/api/debug/account' });
    expect(res.statusCode).toBe(404);
  });

  it('renvoie 502 avec un message clair si la clé est expirée', async () => {
    await setup(sequenceFetch(jsonResponse({}, 403)));
    const res = await app.inject({ method: 'GET', url: '/api/debug/account' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/developer\.riotgames\.com/);
  });
});

describe('CORS pour les widgets', () => {
  it('répond au préflight, y compris Private Network Access', async () => {
    const db = openDb(':memory:');
    const { app } = await buildApp({ config: testConfig(), db, logger: false });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: {
        origin: 'null',
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('null');
    expect(res.headers['access-control-allow-private-network']).toBe('true');
    await app.close();
    db.close();
  });
});
