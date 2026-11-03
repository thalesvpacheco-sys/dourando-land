import { pathToFileURL } from 'node:url';
import { db } from './db/knex.js';
import { processOutbox } from './integrations/crm.js';

/**
 * Worker: entrega ao CRM (outbox com retentativas) e retenção de dados.
 * Em produção roda como processo separado (`npm run worker`); em desenvolvimento, embutido na API.
 * Para cluster, trocar os timers por fila Redis (BullMQ) — o SKIP LOCKED já impede processamento duplo.
 */
export function startWorker() {
  const tick = async () => {
    try {
      await processOutbox(25);
    } catch (e: any) {
      console.error(JSON.stringify({ level: 'error', msg: 'outbox', err: e.message }));
    }
  };
  const retention = async () => {
    // cliques anônimos (sem dado pessoal) com mais de 24 meses perdem atribuição e hash de IP
    await db('opportunity_interests').whereNull('name').andWhere('created_at', '<', db.raw(`now() - interval '24 months'`)).update({ attribution: '{}', ip_hash: null }).catch(() => {});
  };
  setInterval(tick, 15_000).unref();
  setInterval(retention, 6 * 3600_000).unref();
  void tick();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Worker iniciado');
  startWorker();
  setInterval(() => {}, 1 << 30);
}
