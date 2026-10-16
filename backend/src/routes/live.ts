import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';

export function liveRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    /**
     * Partie en cours : `{ game: null }` hors partie, sinon les 10 joueurs enrichis progressivement
     * (`game.status` = « partial » tant que l'analyse n'est pas terminée).
     */
    app.get('/', async () => ({ game: await deps.live.get() }));
  };
}
