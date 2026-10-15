import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

// Le .env vit à la racine du projet : backend/{src|dist}/config.* → ../../.env
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const RIOT_ID_RE = /^(.{3,16})#([A-Za-z0-9]{2,5})$/;

const EnvSchema = z.object({
  RIOT_API_KEY: z.string({ error: 'RIOT_API_KEY manquante dans .env' }).trim().min(1, 'RIOT_API_KEY vide dans .env'),
  RIOT_ID: z
    .string()
    .trim()
    .regex(RIOT_ID_RE, 'RIOT_ID doit être au format gameName#tagLine, entre guillemets dans .env (RIOT_ID="Nom#TAG")')
    .default('Maksenoff#EUW'),
  RIOT_REGION: z.enum(['europe', 'americas', 'asia', 'sea']).default('europe'),
  RIOT_PLATFORM: z.string().trim().min(2).default('euw1'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3417),
  DATA_DIR: z.string().trim().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface AppConfig {
  riotApiKey: string;
  riotId: { gameName: string; tagLine: string };
  region: string;
  platform: string;
  port: number;
  host: 'localhost';
  dataDir: string;
  logLevel: string;
}

function defaultDataDir(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'xeneon-lol');
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration invalide (.env) :\n${issues}`);
  }
  const e = parsed.data;
  const [, gameName, tagLine] = RIOT_ID_RE.exec(e.RIOT_ID)!;
  return {
    riotApiKey: e.RIOT_API_KEY,
    riotId: { gameName: gameName!, tagLine: tagLine! },
    region: e.RIOT_REGION,
    platform: e.RIOT_PLATFORM,
    port: e.PORT,
    // Boucle locale uniquement (::1 et 127.0.0.1), jamais exposé sur le réseau local.
    // « localhost » plutôt que 127.0.0.1 : iCUE n'accepte que ce nom dans les permissions des widgets.
    host: 'localhost',
    dataDir: e.DATA_DIR ? path.resolve(e.DATA_DIR) : defaultDataDir(),
    logLevel: e.LOG_LEVEL,
  };
}

export function loadConfig(): AppConfig {
  loadDotenv({ path: path.join(ROOT_DIR, '.env'), quiet: true });
  return parseConfig(process.env);
}
