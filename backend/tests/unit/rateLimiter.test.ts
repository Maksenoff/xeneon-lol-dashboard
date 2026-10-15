import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostRateLimiter, parseRateLimitHeader, Priority } from '../../src/riot/rateLimiter.js';

describe('parseRateLimitHeader', () => {
  it('lit le format Riot "count:seconds,…"', () => {
    expect(parseRateLimitHeader('20:1,100:120')).toEqual([
      { count: 20, windowMs: 1000 },
      { count: 100, windowMs: 120000 },
    ]);
  });
  it('ignore les valeurs absentes ou invalides', () => {
    expect(parseRateLimitHeader(null)).toEqual([]);
    expect(parseRateLimitHeader('abc,0:1,5:x')).toEqual([]);
  });
});

describe('HostRateLimiter', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  /** Lance n acquisitions et renvoie les instants (ms) où chacune a été accordée. */
  function track(limiter: HostRateLimiter, n: number, method = 'm', priority = Priority.Session) {
    const granted: number[] = [];
    for (let i = 0; i < n; i++) void limiter.acquire(method, priority).then(() => granted.push(Date.now()));
    return granted;
  }

  it('respecte la fenêtre courte (2 req / 1 s)', async () => {
    const limiter = new HostRateLimiter([{ count: 2, windowMs: 1000 }]);
    const granted = track(limiter, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(granted).toHaveLength(3);
    expect(granted[2]).toBeGreaterThanOrEqual(1000);
  });

  it('respecte la fenêtre longue en plus de la courte', async () => {
    const limiter = new HostRateLimiter([
      { count: 2, windowMs: 1000 },
      { count: 3, windowMs: 10_000 },
    ]);
    const granted = track(limiter, 4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(granted).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(6000);
    expect(granted).toHaveLength(4);
    expect(granted[3]).toBeGreaterThanOrEqual(10_000);
  });

  it('sert la priorité Live avant les tâches de fond', async () => {
    const limiter = new HostRateLimiter([{ count: 1, windowMs: 1000 }]);
    const order: string[] = [];
    void limiter.acquire('m').then(() => order.push('first'));
    void limiter.acquire('m', Priority.Background).then(() => order.push('background'));
    void limiter.acquire('m', Priority.Live).then(() => order.push('live'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(order).toEqual(['first', 'live', 'background']);
  });

  it('applique les limites de méthode annoncées par Riot', async () => {
    const limiter = new HostRateLimiter([{ count: 100, windowMs: 1000 }]);
    limiter.updateFromHeaders('slow', new Headers({ 'x-method-rate-limit': '1:10' }));
    const slow = track(limiter, 2, 'slow');
    const fast = track(limiter, 3, 'fast');
    await vi.advanceTimersByTimeAsync(0);
    expect(slow).toHaveLength(1);
    expect(fast).toHaveLength(3); // une autre méthode n'est pas bloquée
    await vi.advanceTimersByTimeAsync(10_200);
    expect(slow).toHaveLength(2);
  });

  it('block() suspend l’hôte pendant Retry-After', async () => {
    const limiter = new HostRateLimiter([{ count: 100, windowMs: 1000 }]);
    limiter.block(5000);
    const granted = track(limiter, 1);
    await vi.advanceTimersByTimeAsync(4900);
    expect(granted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(granted).toEqual([5000]);
  });

  it('se resynchronise sur le compteur serveur (ex. après redémarrage)', async () => {
    const limiter = new HostRateLimiter([{ count: 3, windowMs: 1000 }]);
    limiter.updateFromHeaders('m', new Headers({ 'x-app-rate-limit': '3:1', 'x-app-rate-limit-count': '3:1' }));
    const granted = track(limiter, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1200);
    expect(granted).toHaveLength(1);
  });
});
