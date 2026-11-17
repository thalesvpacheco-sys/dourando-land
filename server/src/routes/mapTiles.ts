/**
 * Satélite (Mapbox Static Tiles, estilo satellite-v9, blocos de 512 px) servido pelo próprio portal: o token fica só no servidor e nunca chega ao navegador.
 *
 * Proteções, além de esconder o token:
 *  - só atende o próprio site (Sec-Fetch-Site: same-origin), então outro site não consegue embutir os blocos;
 *  - limite por IP (cada tela de mapa pede dezenas de blocos; o limite corta robôs, não o uso normal);
 *  - cache em memória pelo tempo que a própria Mapbox autoriza para caches intermediários (s-maxage, hoje 12 h):
 *    bloco repetido sai na hora e não gasta cota;
 *  - teto diário (MAPBOX_DAILY_LIMIT, padrão 6 mil ≈ 180 mil/mês, abaixo da faixa gratuita da Static Tiles API):
 *    passado o teto, o mapa volta para a base própria até o dia seguinte, em vez de gerar cobrança.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { log } from '../lib/log.js';

const TOKEN = process.env.MAPBOX_TOKEN ?? '';
const DAILY_LIMIT = Number(process.env.MAPBOX_DAILY_LIMIT ?? 6000);
export const satelliteEnabled = () => !!TOKEN;

// cache LRU (Map mantém ordem de inserção): ~2.500 blocos de ~65 KB ≈ 160 MB no máximo
const CACHE_MAX = Number(process.env.MAPBOX_CACHE_TILES ?? 2500);
const cache = new Map<string, { body: Buffer; type: string; expires: number }>();
const inflight = new Map<string, Promise<{ body: Buffer; type: string; maxAge: number } | number>>();

let day = '';
let count = 0;
let warned = false;

export const router = Router();
// uma tela em 3D pede dezenas de blocos e cada zoom pede mais; o limite segura robôs sem travar quem navega rápido
router.use(rateLimit({ windowMs: 60_000, limit: 3000, standardHeaders: true, legacyHeaders: false }));

router.get('/satellite/:z/:x/:y', async (req, res) => {
  if (!TOKEN) return void res.status(404).end();
  const [z, x, y] = [req.params.z, req.params.x, req.params.y].map(Number);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return void res.status(400).end();
  if (config.isProd && req.headers['sec-fetch-site'] !== 'same-origin') return void res.status(403).end();

  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    cache.delete(key); cache.set(key, hit); // mais recente vai para o fim
    res.set({ 'Content-Type': hit.type, 'Cache-Control': `public, max-age=${Math.round((hit.expires - Date.now()) / 1000)}` });
    return void res.end(hit.body);
  }

  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; count = 0; warned = false; }
  if (count >= DAILY_LIMIT) {
    if (!warned) { warned = true; log('warn', 'satellite_daily_limit', { limit: DAILY_LIMIT }); }
    return void res.status(429).end();
  }

  // dois visitantes pedindo o mesmo bloco ao mesmo tempo: uma ida só à Mapbox
  let job = inflight.get(key);
  if (!job) {
    count++;
    job = (async () => {
      try {
        const r = await fetch(`https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/512/${key}?access_token=${TOKEN}`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return r.status === 404 ? 404 : 502;
        const cc = r.headers.get('cache-control') ?? '';
        const maxAge = Number(/s-maxage=(\d+)/.exec(cc)?.[1] ?? /max-age=(\d+)/.exec(cc)?.[1] ?? 3600);
        return { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? 'image/jpeg', maxAge };
      } catch { return 504; } finally { inflight.delete(key); }
    })();
    inflight.set(key, job);
  }
  const out = await job;
  if (typeof out === 'number') return void res.status(out).end();
  if (!cache.has(key)) {
    cache.set(key, { body: out.body, type: out.type, expires: Date.now() + out.maxAge * 1000 });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  res.set({ 'Content-Type': out.type, 'Cache-Control': `public, max-age=${out.maxAge}` });
  res.end(out.body);
});
