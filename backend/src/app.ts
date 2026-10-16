import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { HttpCache } from './riot/cache.js';
import { RiotClient, RiotApiError } from './riot/client.js';
import { Priority, RateLimiterRegistry } from './riot/rateLimiter.js';
import { getMasteryByChampion } from './riot/endpoints/mastery.js';
import { getLeagueEntries } from './riot/endpoints/league.js';
import { AccountService, AccountNotFoundError, InvalidRiotIdError } from './services/accountService.js';
import { accountRoutes } from './routes/account.js';
import { MatchSyncService } from './services/matchSync.js';
import { RankSnapshotService } from './services/rankSnapshots.js';
import { SessionService } from './services/sessionService.js';
import { Poller } from './services/poller.js';
import { DataDragon } from './ddragon/ddragon.js';
import { RankedEmblems } from './ddragon/emblems.js';
import { LiveClient } from './liveclient/liveClient.js';
import { LiveService } from './services/liveService.js';
import { assetsRoutes } from './routes/assets.js';
import { liveRoutes } from './routes/live.js';
import { MatchDetailService } from './services/matchDetail.js';
import { matchRoutes } from './routes/match.js';
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
  ddragon: DataDragon;
  emblems: RankedEmblems;
  live: LiveService;
  matchDetail: MatchDetailService;
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** Injecté par les tests pour simuler Riot. */
  fetchFn?: typeof fetch;
  logger?: boolean | { level: string };
  /** Horloge injectable (tests). */
  now?: () => number;
  /** Live Client injectable (tests) ; par défaut https://127.0.0.1:2999. */
  liveClient?: Pick<LiveClient, 'allGameData'>;
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
  const accounts = new AccountService(db, riot, config.region, config.riotId);
  const matches = new MatchSyncService(db, riot, config.region, app.log);
  const ranks = new RankSnapshotService(db, riot, config.platform, now);
  // Data Dragon : fetch sans clé API (CDN public), injectable pour les tests.
  const ddragon = new DataDragon(config.dataDir, app.log, opts.fetchFn ?? fetch, now);
  const sessions = new SessionService({
    db,
    accounts,
    matches,
    ranks,
    ddragon,
    mastery: (puuid, championId) => getMasteryByChampion(riot, config.platform, puuid, championId, Priority.Session),
    logger: app.log,
    now,
  });
  const poller = new Poller({ accounts, matches, ranks, logger: app.log });
  const emblems = new RankedEmblems(config.dataDir, app.log, opts.fetchFn ?? fetch);
  const live = new LiveService({
    db,
    riot,
    accounts,
    matches,
    liveClient: (opts.liveClient ?? new LiveClient(app.log, config.dataDir)) as LiveClient,
    ddragon,
    region: config.region,
    platform: config.platform,
    dataDir: config.dataDir,
    logger: app.log,
    now,
  });
  const matchDetail = new MatchDetailService({
    db,
    accounts,
    ddragon,
    lpInfo: (puuid, matchId) => sessions.lpInfo(puuid, matchId),
    // Rang des 10 joueurs : cache 1 h (évite de refaire 10 requêtes à chaque ouverture de fiche).
    league: (puuid) => getLeagueEntries(riot, config.platform, puuid, Priority.Session, 3600_000).catch(() => null),
  });
  const deps: AppDeps = { config, db, cache, riot, accounts, matches, ranks, sessions, poller, ddragon, emblems, live, matchDetail };

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
    if (err instanceof InvalidRiotIdError) {
      return reply.status(400).send({ error: err.message });
    }
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
  await app.register(accountRoutes(deps), { prefix: '/api/account' });
  await app.register(sessionRoutes(deps), { prefix: '/api/session' });
  await app.register(assetsRoutes(deps), { prefix: '/api/assets' });
  await app.register(liveRoutes(deps), { prefix: '/api/live' });
  await app.register(matchRoutes(deps), { prefix: '/api/match' });

  app.addHook('onClose', async () => poller.stop());

  return { app, deps };
}
