import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';
import { MatchNotFoundError } from '../services/matchDetail.js';

export function matchRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    /** Détail d'une partie déjà synchronisée (ex. EUW1_8014332134). */
    app.get<{ Params: { matchId: string } }>('/:matchId', async (req, reply) => {
      if (!/^[A-Z0-9]{2,5}_\d{5,15}$/.test(req.params.matchId)) {
        return reply.status(400).send({ error: 'Identifiant de partie invalide' });
      }
      try {
        return await deps.matchDetail.get(req.params.matchId);
      } catch (err) {
        if (err instanceof MatchNotFoundError) return reply.status(404).send({ error: err.message });
        throw err;
      }
    });
  };
}
