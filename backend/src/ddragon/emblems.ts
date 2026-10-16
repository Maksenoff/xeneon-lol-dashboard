import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Logger } from '../riot/client.js';

/**
 * Emblèmes de rang officiels, fournis par Riot sur le portail développeur
 * (https://static.developer.riotgames.com/docs/lol/ranked-emblems-latest.zip, ~64 Mo).
 * Le pack est téléchargé une seule fois ; seuls les 10 fichiers « Rank=<Tier>.png » (1000×1000)
 * sont extraits dans <DATA_DIR>/emblems/, puis le zip est jeté.
 */

const ZIP_URL = 'https://static.developer.riotgames.com/docs/lol/ranked-emblems-latest.zip';
export const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];

export class RankedEmblems {
  private extracting: Promise<void> | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private file(tier: string): string {
    return path.join(this.dataDir, 'emblems', `${tier}.png`);
  }

  async get(tier: string): Promise<Buffer | null> {
    const t = tier.toLowerCase();
    if (!TIERS.includes(t)) return null;
    try {
      return await fs.readFile(this.file(t));
    } catch {
      await this.extractAll();
      return fs.readFile(this.file(t)).catch(() => null);
    }
  }

  private extractAll(): Promise<void> {
    this.extracting ??= this.download()
      .catch((err) => this.logger.warn({ err: String(err) }, 'Emblèmes de rang indisponibles'))
      .finally(() => {
        this.extracting = null;
      });
    return this.extracting;
  }

  private async download(): Promise<void> {
    this.logger.info({}, 'Téléchargement des emblèmes de rang officiels (une seule fois)');
    const res = await this.fetchFn(ZIP_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    await fs.mkdir(path.join(this.dataDir, 'emblems'), { recursive: true });
    let count = 0;
    for (const entry of zip.getEntries()) {
      // « Ranked Emblems Latest/Rank=Emerald.png » ; on ignore les variantes « Wings »
      const m = /(?:^|\/)Rank=([A-Za-z]+)\.png$/.exec(entry.entryName);
      const tier = m?.[1]?.toLowerCase();
      if (!tier || !TIERS.includes(tier)) continue;
      await fs.writeFile(this.file(tier), entry.getData());
      count++;
    }
    this.logger.info({ count }, 'Emblèmes de rang extraits');
  }
}
