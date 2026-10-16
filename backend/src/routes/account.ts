import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';

/** Compte suivi, modifiable depuis les réglages du widget. */
export function accountRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async () => {
      const tracked = deps.accounts.tracked();
      const account = await deps.accounts.me();
      return { ...account, isDefault: tracked.isDefault };
    });

    /**
     * POST /api/account?riotId=Nom%23TAG — vérifie le compte chez Riot puis le suit.
     * riotId vide → retour au compte du .env. Paramètre en query (pas de corps JSON) :
     * la requête reste « simple » pour le navigateur des widgets, sans préflight CORS.
     */
    app.post<{ Querystring: { riotId?: string } }>(
      '/',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: { riotId: { type: 'string', maxLength: 40 } },
            additionalProperties: false,
          },
        },
      },
      async (req) => {
        const before = (await deps.accounts.me()).puuid;
        const account = await deps.accounts.setTracked(req.query.riotId ?? '');
        if (account.puuid !== before) {
          req.log.info({ riotId: `${account.gameName}#${account.tagLine}` }, 'Compte suivi changé');
          deps.poller.kick(); // historique + snapshot du nouveau compte sans attendre le prochain cycle
        }
        return { ...account, isDefault: deps.accounts.tracked().isDefault };
      },
    );
  };
}
