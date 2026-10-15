import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';
import { MODE_NAMES, type Mode } from '../domain/queues.js';
import { PERIODS, type Period } from '../domain/periods.js';

interface SessionQuery {
  mode?: Mode;
  period?: Period;
}

export function sessionRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    /** Démarre une session (bouton « Démarrer la session » du widget). */
    app.post('/start', async (_req, reply) => {
      const session = await deps.sessions.start();
      return reply.status(201).send({ session });
    });

    /** Termine la session en cours. */
    app.post('/stop', async () => ({ session: deps.sessions.stop() }));

    /**
     * Résumé : parties, W/L, LP net, temps joué, KDA, séries, historique détaillé.
     * Avec period=session et aucune session active, renvoie `session: null` et des compteurs à zéro.
     */
    app.get<{ Querystring: SessionQuery }>(
      '/',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: MODE_NAMES, default: 'rsolo' },
              period: { type: 'string', enum: [...PERIODS], default: 'session' },
            },
            additionalProperties: false,
          },
        },
      },
      async (req) => deps.sessions.summary(req.query.mode ?? 'rsolo', req.query.period ?? 'session'),
    );
  };
}
