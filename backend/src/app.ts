import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { HttpCache } from './riot/cache.js';
import { RiotClient, RiotApiError } from './riot/client.js';
import { RateLimiterRegistry } from './riot/rateLimiter.js';
import { AccountService, AccountNotFoundError } from './services/accountService.js';
import { MatchSyncService } from './services/matchSync.js';
import { RankSnapshotService } from './services/rankSnapshots.js';
import { SessionService } from './services/sessionService.js';
import { Poller } from './services/poller.js';
import { healthRoutes } from './routes/health.js';
import { debugRoutes } from './routes/debug.js';
import { sessionRoutes } from './routes/session.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  cache: HttpCache;
  riot: RiotClient;
  accounts: AccountService;
  matches: MatchSyncService;
  ranks: RankSnapshotService;
  sessions: SessionService;
  poller: Poller;
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** Injecté par les tests pour simuler Riot. */
  fetchFn?: typeof fetch;
  logger?: boolean | { level: string };
  /** Horloge injectable (tests). */
  now?: () => number;
}

export async function buildApp(opts: BuildAppOptions): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const app = Fastify({ logger: opts.logger ?? { level: opts.config.logLevel } });
  const { config, db } = opts;
  const now = opts.now ?? Date.now;

  const cache = new HttpCache(db, now);
  const riot = new RiotClient({
    apiKey: config.riotApiKey,
    cache,
    limiters: new RateLimiterRegistry(),
    fetchFn: opts.fetchFn,
    logger: app.log,
  });
  const accounts = new AccountService(db, riot, config.region);
  const matches = new MatchSyncService(db, riot, config.region, app.log);
  const ranks = new RankSnapshotService(db, riot, config.platform, now);
  const sessions = new SessionService({ db, accounts, matches, ranks, riotId: config.riotId, logger: app.log, now });
  const poller = new Poller({ accounts, matches, ranks, riotId: config.riotId, logger: app.log });
  const deps: AppDeps = { config, db, cache, riot, accounts, matches, ranks, sessions, poller };

  // Les widgets iCUE tournent dans QtWebEngine (Chromium 130) depuis file:// :
  // on accepte toute origine, le serveur n'écoutant qu'en local.
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
  await app.register(sessionRoutes(deps), { prefix: '/api/session' });

  app.addHook('onClose', async () => poller.stop());

  return { app, deps };
}
