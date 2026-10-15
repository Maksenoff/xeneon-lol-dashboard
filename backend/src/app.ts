import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { HttpCache } from './riot/cache.js';
import { RiotClient, RiotApiError } from './riot/client.js';
import { RateLimiterRegistry } from './riot/rateLimiter.js';
import { AccountService, AccountNotFoundError } from './services/accountService.js';
import { healthRoutes } from './routes/health.js';
import { debugRoutes } from './routes/debug.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  cache: HttpCache;
  riot: RiotClient;
  accounts: AccountService;
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** Injecté par les tests pour simuler Riot. */
  fetchFn?: typeof fetch;
  logger?: boolean | { level: string };
}

export async function buildApp(opts: BuildAppOptions): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const app = Fastify({ logger: opts.logger ?? { level: opts.config.logLevel } });

  const cache = new HttpCache(opts.db);
  const riot = new RiotClient({
    apiKey: opts.config.riotApiKey,
    cache,
    limiters: new RateLimiterRegistry(),
    fetchFn: opts.fetchFn,
    logger: app.log,
  });
  const deps: AppDeps = {
    config: opts.config,
    db: opts.db,
    cache,
    riot,
    accounts: new AccountService(opts.db, riot, opts.config.region),
  };

  // Les widgets iCUE tournent dans QtWebEngine (Chromium 130) avec une origine non documentée :
  // on accepte toute origine, le serveur n'écoutant que sur 127.0.0.1.
  // Chromium peut aussi envoyer un préflight « Private Network Access » vers localhost.
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['access-control-request-private-network'] === 'true') {
      reply.header('Access-Control-Allow-Private-Network', 'true');
    }
  });
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AccountNotFoundError) {
      return reply.status(404).send({ error: err.message });
    }
    if (err instanceof RiotApiError) {
      req.log.error({ status: err.status, path: err.path }, err.message);
      return reply.status(502).send({ error: err.message, riotStatus: err.status });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? 'Erreur interne' : (err as Error).message });
  });

  await app.register(healthRoutes(deps), { prefix: '/api' });
  await app.register(debugRoutes(deps), { prefix: '/api/debug' });

  return { app, deps };
}
