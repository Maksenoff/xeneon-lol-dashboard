import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';

/** Routes de diagnostic (étape 2). */
export function debugRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    /** Résout le compte suivi en PUUID via Account-V1. */
    app.get('/account', async () => deps.accounts.me());
  };
}
