import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';

const startedAt = Date.now();

export function healthRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.get('/health', async () => ({
      ok: true,
      riotId: `${deps.config.riotId.gameName}#${deps.config.riotId.tagLine}`,
      region: deps.config.region,
      platform: deps.config.platform,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      serverTime: new Date().toISOString(),
    }));
  };
}
