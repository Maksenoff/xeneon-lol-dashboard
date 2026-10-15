import type { HttpCache } from './cache.js';
import { Priority, type RateLimiterRegistry } from './rateLimiter.js';

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {} };

export interface RiotRequest {
  /** Hôte de routage : région (`europe`) ou plateforme (`euw1`). */
  host: string;
  /** Chemin déjà encodé, ex. `/riot/account/v1/accounts/by-riot-id/x/y`. */
  path: string;
  query?: Record<string, string | number | undefined>;
  /** Clé stable de l'endpoint pour les limites « méthode », ex. `match-v5:ids`. */
  methodKey: string;
  /** Durée de cache ; Infinity pour une donnée immuable, 0 pour ne pas cacher. */
  ttlMs: number;
  priority?: Priority;
  /** Un 404 est une réponse normale (ex. « pas en partie ») → renvoie null. */
  notFoundAsNull?: boolean;
}

export class RiotApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'RiotApiError';
  }
}

const HOST_RE = /^[a-z0-9]+$/;

export interface RiotClientOptions {
  apiKey: string;
  cache: HttpCache;
  limiters: RateLimiterRegistry;
  fetchFn?: typeof fetch;
  logger?: Logger;
  maxRetries?: number;
  timeoutMs?: number;
}

export class RiotClient {
  private readonly fetchFn: typeof fetch;
  private readonly logger: Logger;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: RiotClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.logger = opts.logger ?? noopLogger;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** GET JSON via cache → file/limiteur → Riot. */
  async get<T>(req: RiotRequest): Promise<T | null> {
    const url = this.buildUrl(req);

    const cached = req.ttlMs > 0 ? this.opts.cache.get(url) : undefined;
    if (cached) return this.fromCache<T>(cached.status, cached.body, req);

    // Évite de lancer deux fois la même requête en parallèle.
    const existing = this.inflight.get(url);
    if (existing) return existing as Promise<T | null>;

    const promise = this.fetchWithRetry<T>(url, req).finally(() => this.inflight.delete(url));
    this.inflight.set(url, promise);
    return promise;
  }

  private buildUrl(req: RiotRequest): string {
    if (!HOST_RE.test(req.host)) throw new Error(`Hôte de routage invalide : ${req.host}`);
    const url = new URL(`https://${req.host}.api.riotgames.com${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private fromCache<T>(status: number, body: string | null, req: RiotRequest): T | null {
    if (status === 404 && req.notFoundAsNull) return null;
    return JSON.parse(body ?? 'null') as T;
  }

  private async fetchWithRetry<T>(url: string, req: RiotRequest): Promise<T | null> {
    const limiter = this.opts.limiters.forHost(req.host);
    const logCtx = { method: req.methodKey, path: req.path };
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await limiter.acquire(req.methodKey, req.priority ?? Priority.Session);

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { 'X-Riot-Token': this.opts.apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err;
        this.logger.warn({ ...logCtx, attempt, err: String(err) }, 'Erreur réseau Riot, nouvel essai');
        await sleep(backoffMs(attempt));
        continue;
      }

      limiter.updateFromHeaders(req.methodKey, res.headers);

      if (res.ok) {
        const text = await res.text();
        if (req.ttlMs > 0) this.opts.cache.set(url, res.status, text, req.ttlMs);
        return JSON.parse(text) as T;
      }

      if (res.status === 404 && req.notFoundAsNull) {
        if (req.ttlMs > 0) this.opts.cache.set(url, 404, null, req.ttlMs);
        return null;
      }

      if (res.status === 429) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after')) ?? backoffMs(attempt);
        const type = res.headers.get('x-rate-limit-type'); // application | method | service
        this.logger.warn({ ...logCtx, attempt, retryAfterMs, type }, 'Riot 429 : attente de Retry-After');
        if (type === 'application') limiter.block(retryAfterMs);
        else if (type === 'method') limiter.block(retryAfterMs, req.methodKey);
        else await sleep(retryAfterMs); // limite « service » côté Riot : on attend sans bloquer l'hôte
        lastError = new RiotApiError(429, req.path, 'Rate limit Riot dépassé');
        continue;
      }

      if (res.status >= 500) {
        lastError = new RiotApiError(res.status, req.path, `Erreur serveur Riot ${res.status}`);
        this.logger.warn({ ...logCtx, attempt, status: res.status }, 'Erreur serveur Riot, nouvel essai');
        await sleep(backoffMs(attempt));
        continue;
      }

      // 400, 401, 403, 404 inattendu… : inutile de réessayer.
      throw new RiotApiError(res.status, req.path, describeStatus(res.status));
    }

    // Plus d'essais : on sert la dernière valeur connue si elle existe.
    const stale = this.opts.cache.getAny(url);
    if (stale) {
      this.logger.warn({ ...logCtx }, 'Riot indisponible : réponse en cache expirée servie');
      return this.fromCache<T>(stale.status, stale.body, req);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Requête invalide (400)';
    case 401:
      return 'Clé API inconnue de Riot (401) : vérifie RIOT_API_KEY dans .env';
    case 403:
      return 'Clé API refusée (403) : une clé de développement expire après 24 h, régénère-la sur developer.riotgames.com';
    case 404:
      return 'Ressource introuvable (404)';
    default:
      return `Erreur Riot ${status}`;
  }
}
