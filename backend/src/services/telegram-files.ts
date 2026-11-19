/**
 * Reads files (selfies, ID cards, shop photos) that users sent to the bot. Files stay on
 * Telegram's servers; we only keep their file ids and fetch them on demand for the admin
 * dashboard and the buyer's "who is delivering" card. A small in-memory cache avoids
 * re-downloading the same image while an admin flips through a review.
 */
export interface FileFetcher {
  fetch(fileId: string): Promise<{ mime: string; data: Buffer }>;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', pdf: 'application/pdf'
};

export class TelegramFiles implements FileFetcher {
  private cache = new Map<string, { mime: string; data: Buffer; at: number }>();

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxEntries = 100
  ) {}

  async fetch(fileId: string): Promise<{ mime: string; data: Buffer }> {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new Error('Invalid file id');
    const hit = this.cache.get(fileId);
    if (hit) return hit;

    const meta = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(15_000)
    });
    const body = (await meta.json()) as { ok: boolean; result?: { file_path?: string } };
    const filePath = body.result?.file_path;
    if (!body.ok || !filePath) throw new Error('File not found on Telegram');

    const res = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${filePath}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
    const data = Buffer.from(await res.arrayBuffer());
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const entry = { mime: MIME_BY_EXT[ext] ?? 'application/octet-stream', data, at: Date.now() };

    this.cache.set(fileId, entry);
    if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }
}
