import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';

/** Routes de diagnostic (étape 2). */
export function debugRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    /** Résout le compte suivi en PUUID via Account-V1. */
    app.get('/account', async () => deps.accounts.me());

    /** Rejoue une partie stockée comme si elle était en cours (aperçu de la vue « partie en cours »). */
    app.get<{ Params: { matchId: string } }>('/replay/:matchId', async (req, reply) => {
      if (!/^[A-Z0-9]{2,5}_\d{5,15}$/.test(req.params.matchId)) return reply.status(400).send({ error: 'Identifiant invalide' });
      const game = await deps.live.replay(req.params.matchId);
      return game ? { game } : reply.status(404).send({ error: 'Partie inconnue' });
    });
  };
}
