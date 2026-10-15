/**
 * Limiteur de débit Riot, une instance par hôte de routage (`europe`, `euw1`…) :
 * les limites « application » de Riot s'appliquent par région/plateforme,
 * les limites « méthode » par endpoint ET par région.
 *
 * - Les limites sont apprises depuis les headers X-App-Rate-Limit / X-Method-Rate-Limit
 *   (format "20:1,100:120" = 20 req / 1 s et 100 req / 120 s).
 * - Avant la première réponse, on applique les limites d'une clé de développement.
 * - Les compteurs serveur (X-*-Rate-Limit-Count) resynchronisent l'état local,
 *   utile si le backend redémarre au milieu d'une fenêtre.
 * - File d'attente à priorités : la partie en cours passe avant la session, qui passe
 *   avant les tâches de fond.
 */

export enum Priority {
  Live = 0,
  Session = 1,
  Background = 2,
}

export interface Limit {
  count: number;
  windowMs: number;
}

/** Limites par défaut d'une clé de développement Riot. */
export const DEV_KEY_APP_LIMITS: Limit[] = [
  { count: 20, windowMs: 1_000 },
  { count: 100, windowMs: 120_000 },
];

/** Marge ajoutée à chaque attente pour absorber latence réseau et décalage d'horloge. */
const SAFETY_MARGIN_MS = 100;

/** "20:1,100:120" → [{count:20, windowMs:1000}, {count:100, windowMs:120000}] */
export function parseRateLimitHeader(value: string | null | undefined): Limit[] {
  if (!value) return [];
  const limits: Limit[] = [];
  for (const part of value.split(',')) {
    const [count, seconds] = part.trim().split(':').map(Number);
    if (Number.isFinite(count) && Number.isFinite(seconds) && count! > 0 && seconds! > 0) {
      limits.push({ count: count!, windowMs: seconds! * 1000 });
    }
  }
  return limits;
}

class Scope {
  /** Horodatages des requêtes émises, triés croissants. */
  private hits: number[] = [];
  blockedUntil = 0;

  constructor(public limits: Limit[]) {}

  private maxWindow(): number {
    return this.limits.reduce((m, l) => Math.max(m, l.windowMs), 0);
  }

  private prune(now: number): void {
    const cutoff = now - this.maxWindow();
    let i = 0;
    while (i < this.hits.length && this.hits[i]! <= cutoff) i++;
    if (i > 0) this.hits.splice(0, i);
  }

  private countSince(since: number): number {
    let n = 0;
    for (let i = this.hits.length - 1; i >= 0 && this.hits[i]! > since; i--) n++;
    return n;
  }

  /** Temps à attendre avant de pouvoir émettre une requête (0 = maintenant). */
  waitMs(now: number): number {
    this.prune(now);
    let wait = Math.max(0, this.blockedUntil - now);
    for (const { count, windowMs } of this.limits) {
      const inWindow = this.countSince(now - windowMs);
      if (inWindow >= count) {
        // Il faut que les (inWindow - count + 1) plus anciennes requêtes de la fenêtre expirent :
        // la dernière d'entre elles est à l'index length - count.
        const oldest = this.hits[this.hits.length - count]!;
        wait = Math.max(wait, oldest + windowMs - now + SAFETY_MARGIN_MS);
      }
    }
    return wait;
  }

  record(now: number): void {
    this.hits.push(now);
  }

  /** Aligne le compteur local sur celui annoncé par Riot s'il est plus élevé. */
  syncCounts(serverCounts: Limit[], now: number): void {
    for (const { count: serverCount, windowMs } of serverCounts) {
      const missing = serverCount - this.countSince(now - windowMs);
      for (let i = 0; i < missing; i++) this.hits.push(now);
    }
  }
}

interface Waiter {
  methodKey: string;
  priority: Priority;
  seq: number;
  resolve: () => void;
}

export class HostRateLimiter {
  private readonly app: Scope;
  private readonly methods = new Map<string, Scope>();
  private queue: Waiter[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    appLimits: Limit[] = DEV_KEY_APP_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.app = new Scope(appLimits);
  }

  /** Résout quand la requête peut partir ; le créneau est alors réservé. */
  acquire(methodKey: string, priority: Priority = Priority.Session): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ methodKey, priority, seq: this.seq++, resolve });
      this.pump();
    });
  }

  /** À appeler sur chaque réponse Riot (y compris 429). */
  updateFromHeaders(methodKey: string, headers: Headers): void {
    const now = this.now();
    const appLimits = parseRateLimitHeader(headers.get('x-app-rate-limit'));
    if (appLimits.length) this.app.limits = appLimits;
    this.app.syncCounts(parseRateLimitHeader(headers.get('x-app-rate-limit-count')), now);

    const methodLimits = parseRateLimitHeader(headers.get('x-method-rate-limit'));
    const method = this.method(methodKey);
    if (methodLimits.length) method.limits = methodLimits;
    method.syncCounts(parseRateLimitHeader(headers.get('x-method-rate-limit-count')), now);
    this.pump();
  }

  /** Bloque toute l'application (methodKey absent) ou une méthode, après un 429. */
  block(ms: number, methodKey?: string): void {
    const scope = methodKey ? this.method(methodKey) : this.app;
    scope.blockedUntil = Math.max(scope.blockedUntil, this.now() + ms);
    this.pump();
  }

  get pending(): number {
    return this.queue.length;
  }

  private method(key: string): Scope {
    let scope = this.methods.get(key);
    if (!scope) {
      scope = new Scope([]); // limites inconnues tant que Riot ne les a pas annoncées
      this.methods.set(key, scope);
    }
    return scope;
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.now();
    let minWait = Infinity;
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);

    for (let i = 0; i < this.queue.length; ) {
      const waiter = this.queue[i]!;
      const method = this.method(waiter.methodKey);
      const wait = Math.max(this.app.waitMs(now), method.waitMs(now));
      if (wait === 0) {
        this.app.record(now);
        method.record(now);
        this.queue.splice(i, 1);
        waiter.resolve();
      } else {
        minWait = Math.min(minWait, wait);
        i++;
      }
    }

    if (this.queue.length > 0 && Number.isFinite(minWait)) {
      this.timer = setTimeout(() => this.pump(), minWait);
      this.timer.unref?.();
    }
  }
}

export class RateLimiterRegistry {
  private readonly limiters = new Map<string, HostRateLimiter>();

  constructor(private readonly now: () => number = Date.now) {}

  forHost(host: string): HostRateLimiter {
    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = new HostRateLimiter(DEV_KEY_APP_LIMITS, this.now);
      this.limiters.set(host, limiter);
    }
    return limiter;
  }
}
