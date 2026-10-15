import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    console.error('→ Vérifie le fichier .env à la racine du projet (modèle : .env.example).');
    process.exit(1);
  }

  const db = openDb(config.dataDir);
  const { app, deps } = await buildApp({ config, db });

  deps.cache.purge();
  const purgeTimer = setInterval(() => deps.cache.purge(), 3600_000);
  purgeTimer.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Arrêt');
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ dataDir: config.dataDir }, `Backend prêt sur http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
