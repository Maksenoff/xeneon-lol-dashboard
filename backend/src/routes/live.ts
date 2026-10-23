import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';
import { MAX_TAGS, TAG_CATALOG } from '../domain/tags.js';

export function liveRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    /**
     * Partie en cours : `{ game: null }` hors partie, sinon les 10 joueurs enrichis progressivement
     * (`game.status` = « partial » tant que l'analyse n'est pas terminée).
     */
    app.get('/', async () => ({ game: await deps.live.get() }));

    /** Catalogue de tous les repères possibles (règles, familles, exemples). */
    app.get('/tags', async () => ({ maxPerPlayer: MAX_TAGS, tags: TAG_CATALOG }));
  };
}
