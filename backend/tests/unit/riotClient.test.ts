import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/index.js';
import { HttpCache } from '../../src/riot/cache.js';
import { RiotApiError, RiotClient, type RiotRequest } from '../../src/riot/client.js';
import { RateLimiterRegistry } from '../../src/riot/rateLimiter.js';
import { jsonResponse, sequenceFetch, TEST_API_KEY } from '../helpers.js';

const REQ: RiotRequest = { host: 'europe', path: '/test/v1/thing', methodKey: 'test', ttlMs: 60_000 };

describe('RiotClient', () => {
  let db: Db;
  let cache: HttpCache;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    db = openDb(':memory:');
    cache = new HttpCache(db);
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function client(fetchFn: typeof fetch, maxRetries = 4) {
    return new RiotClient({ apiKey: TEST_API_KEY, cache, limiters: new RateLimiterRegistry(), fetchFn, maxRetries });
  }

  it('envoie la clé dans le header X-Riot-Token (jamais dans l’URL)', async () => {
    const fetchFn = sequenceFetch(jsonResponse({ ok: 1 }));
    await client(fetchFn).get({ ...REQ, query: { count: 5, start: undefined } });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('https://europe.api.riotgames.com/test/v1/thing?count=5');
    expect(String(url)).not.toContain(TEST_API_KEY);
    expect((init!.headers as Record<string, string>)['X-Riot-Token']).toBe(TEST_API_KEY);
  });

  it('sert la 2e requête depuis le cache, puis refait l’appel après expiration', async () => {
    const fetchFn = sequenceFetch(jsonResponse({ v: 1 }), jsonResponse({ v: 2 }));
    const c = client(fetchFn);
    expect(await c.get(REQ)).toEqual({ v: 1 });
    expect(await c.get(REQ)).toEqual({ v: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    expect(await c.get(REQ)).toEqual({ v: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fusionne deux requêtes identiques simultanées', async () => {
    const fetchFn = sequenceFetch(jsonResponse({ v: 1 }));
    const c = client(fetchFn);
    const [a, b] = await Promise.all([c.get(REQ), c.get(REQ)]);
    expect(a).toEqual(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sur 429, attend Retry-After puis réessaie', async () => {
    const fetchFn = sequenceFetch(
      jsonResponse({ status: { status_code: 429 } }, 429, { 'retry-after': '3', 'x-rate-limit-type': 'application' }),
      jsonResponse({ v: 'ok' }),
    );
    const start = Date.now();
    const p = client(fetchFn).get(REQ);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fetchFn).toHaveBeenCalledTimes(1); // toujours bloqué
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toEqual({ v: 'ok' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(3_000);
  });

  it('sur 429 « service » sans type, attend quand même Retry-After', async () => {
    const fetchFn = sequenceFetch(jsonResponse(null, 429, { 'retry-after': '2' }), jsonResponse({ v: 1 }));
    const p = client(fetchFn).get(REQ);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await p).toEqual({ v: 1 });
  });

  it('renvoie null sur 404 attendu et le met en cache', async () => {
    const fetchFn = sequenceFetch(jsonResponse({ status: { status_code: 404 } }, 404));
    const c = client(fetchFn);
    expect(await c.get({ ...REQ, notFoundAsNull: true })).toBeNull();
    expect(await c.get({ ...REQ, notFoundAsNull: true })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('ne réessaie pas sur 403 et explique la clé expirée', async () => {
    const fetchFn = sequenceFetch(jsonResponse({}, 403));
    await expect(client(fetchFn).get(REQ)).rejects.toThrow(/expire après 24 h/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('réessaie les 5xx avec backoff', async () => {
    const fetchFn = sequenceFetch(jsonResponse({}, 503), jsonResponse({}, 500), jsonResponse({ v: 1 }));
    const p = client(fetchFn).get(REQ);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ v: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('après épuisement des essais, sert la valeur expirée du cache', async () => {
    const fetchFn = sequenceFetch(jsonResponse({ v: 'old' }), ...Array.from({ length: 3 }, () => jsonResponse({}, 503)));
    const c = client(fetchFn, 2);
    await c.get(REQ);
    vi.setSystemTime(Date.now() + 120_000);
    const p = c.get(REQ);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ v: 'old' });
  });

  it('lève RiotApiError si rien en cache après épuisement des essais', async () => {
    const fetchFn = sequenceFetch(...Array.from({ length: 3 }, () => jsonResponse({}, 503)));
    const p = client(fetchFn, 2).get(REQ);
    const assertion = expect(p).rejects.toBeInstanceOf(RiotApiError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('refuse un hôte de routage invalide', async () => {
    await expect(client(sequenceFetch()).get({ ...REQ, host: 'evil.com/x' })).rejects.toThrow(/invalide/);
  });
});
