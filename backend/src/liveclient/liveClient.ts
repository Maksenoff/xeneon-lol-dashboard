import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Logger } from '../riot/client.js';

/**
 * Live Client Data API : servie par le client de jeu sur https://127.0.0.1:2999 pendant une partie.
 *
 * Le certificat est signé par l'autorité « LoL Game Engineering Certificate Authority »
 * (certs/riotgames.pem, publié par Riot). On fait confiance à CETTE autorité uniquement, et
 * uniquement pour ce client : le nom d'hôte n'est pas vérifié car le certificat n'est pas émis
 * pour « 127.0.0.1 ». Aucune autre requête du backend n'est concernée.
 *
 * ⚠ Champs non vérifiés sur une vraie partie pendant le développement (d'après la doc Riot) ;
 * la dernière réponse est enregistrée dans <DATA_DIR>/debug/liveclient-last.json.
 */

const BASE = 'https://127.0.0.1:2999';
const CERT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'certs', 'riotgames.pem');

export interface LivePlayer {
  riotId?: string; // « Nom#TAG » (clients récents)
  riotIdGameName?: string;
  riotIdTagLine?: string;
  summonerName?: string;
  championName?: string;
  team?: 'ORDER' | 'CHAOS';
  level?: number;
  /** TOP | JUNGLE | MIDDLE | BOTTOM | UTILITY, parfois vide selon le mode. */
  position?: string;
  scores?: { kills?: number; deaths?: number; assists?: number; creepScore?: number; wardScore?: number };
}

export interface LiveAllGameData {
  allPlayers?: LivePlayer[];
  gameData?: { gameTime?: number; gameMode?: string };
}

export class LiveClient {
  private readonly dispatcher: Agent | null;

  constructor(private readonly logger: Logger, private readonly dataDir: string) {
    let ca: string | null = null;
    try {
      ca = fs.readFileSync(CERT_PATH, 'utf8');
    } catch {
      logger.warn({ path: CERT_PATH }, 'Certificat Riot introuvable : Live Client désactivé');
    }
    this.dispatcher = ca
      ? new Agent({ connect: { ca, checkServerIdentity: () => undefined }, connectTimeout: 1_000 })
      : null;
  }

  /** Données de la partie en cours sur ce PC, ou null si le jeu ne tourne pas. Ne lève jamais. */
  async allGameData(): Promise<LiveAllGameData | null> {
    if (!this.dispatcher) return null;
    try {
      // fetch d'undici (même version que l'Agent) : le certificat Riot ne s'applique qu'ici.
      const res = await undiciFetch(`${BASE}/liveclientdata/allgamedata`, {
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(1_500),
      });
      if (!res.ok) return null;
      const text = await res.text();
      this.saveDebug(text);
      return JSON.parse(text) as LiveAllGameData;
    } catch {
      return null; // jeu fermé, chargement en cours, etc.
    }
  }

  private lastDebugAt = 0;
  private saveDebug(text: string): void {
    if (Date.now() - this.lastDebugAt < 60_000) return;
    this.lastDebugAt = Date.now();
    const dir = path.join(this.dataDir, 'debug');
    fs.promises
      .mkdir(dir, { recursive: true })
      .then(() => fs.promises.writeFile(path.join(dir, 'liveclient-last.json'), text))
      .catch(() => this.logger.debug({}, 'debug liveclient non écrit'));
  }
}
