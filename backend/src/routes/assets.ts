import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';

/** Assets Riot (Data Dragon, emblèmes officiels) servis depuis le cache local : les widgets ne contactent jamais Riot. */
export function assetsRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { id: string } }>('/champion/:id', async (req, reply) => {
      const match = /^(\d{1,5})\.png$/.exec(req.params.id);
      if (!match) return reply.status(400).send({ error: 'Format attendu : /api/assets/champion/<id>.png' });
      const png = await deps.ddragon.championIcon(Number(match[1]));
      if (!png) return reply.status(404).send({ error: 'Icône introuvable' });
      return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=86400').send(png);
    });

    /** Emblème de rang : /api/assets/rank/emerald.png */
    app.get<{ Params: { tier: string } }>('/rank/:tier', async (req, reply) => {
      const match = /^([a-z]+)\.png$/i.exec(req.params.tier);
      if (!match) return reply.status(400).send({ error: 'Format attendu : /api/assets/rank/<tier>.png' });
      const png = await deps.emblems.get(match[1]!);
      if (!png) return reply.status(404).send({ error: 'Emblème introuvable' });
      return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=604800').send(png);
    });

    /**
     * Splash art : /api/assets/splash/Vayne/25.jpg — le champion peut aussi être donné par son nom
     * affiché (« Wukong »), il est résolu via Data Dragon.
     */
    app.get<{ Params: { champion: string; skin: string } }>('/splash/:champion/:skin', async (req, reply) => {
      const skin = /^(\d{1,3})\.jpg$/.exec(req.params.skin);
      if (!skin) return reply.status(400).send({ error: 'Format attendu : /api/assets/splash/<champion>/<n°>.jpg' });
      const key = await deps.ddragon.resolveChampionKey(req.params.champion);
      if (!key) return reply.status(404).send({ error: `Champion inconnu : ${req.params.champion}` });
      const jpg = await deps.ddragon.splash(key, Number(skin[1]));
      if (!jpg) return reply.status(404).send({ error: 'Splash introuvable (numéro de skin ?)' });
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=604800').send(jpg);
    });
  };
}
