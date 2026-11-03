/** Exporta o seed fictício para a demonstração no navegador (web/src/demo/seed.json + imagens). */
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from './knex.js';
import { decrypt } from '../lib/crypto.js';
import { config } from '../config.js';

const out: Record<string, any[]> = {};
const plain = ['organizations', 'users', 'land_brokers', 'land_opportunities', 'land_technical_attributes', 'land_commercial_terms', 'publication_permissions',
  'land_media', 'broker_assignments', 'partner_companies', 'acquisition_profiles', 'opportunity_matches', 'whatsapp_routing_rules', 'opportunity_interests',
  'interest_events', 'whatsapp_inbound', 'negotiations', 'negotiation_participants', 'proposals', 'proposal_versions', 'proposal_approvals', 'commissions',
  'activities', 'crm_contacts', 'audit_logs'];
for (const t of plain) out[t] = await db(t).select('*');
out.land_documents = await db('land_documents').select('*');
out.land_prospects = (await db('land_prospects').select('*', db.raw('ST_AsGeoJSON(geom, 7)::json as geometry'))).map(({ geom, ...p }) => p);
out.land_owners = (await db('land_owners').select('*')).map((o) => ({ ...o, document: decrypt(o.document_enc), document_enc: null }));
out.land_geometries = await db('land_geometries').select('id', 'opportunity_id', 'area_m2', 'perimeter_m', 'source', 'version', 'is_current', 'created_at',
  db.raw('ST_AsGeoJSON(geom, 7)::json as geometry'), db.raw('ST_X(centroid) as c_lng, ST_Y(centroid) as c_lat'), db.raw('ST_X(public_point) as p_lng, ST_Y(public_point) as p_lat'));
// sem o espelho do e2e/testes: apenas o seed
out.audit_logs = out.audit_logs.slice(-50);
for (const u of out.users) delete u.external_id;
const dir = path.resolve('../web/demo-public');
await fs.rm(dir, { recursive: true, force: true });
for (const m of out.land_media) {
  const dst = path.join(dir, m.storage_key);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(path.join(config.storageDir, m.storage_key), dst);
}
// identidade visual: mesma pasta pública do app
await fs.cp(path.resolve('../web/public/brand'), path.join(dir, 'brand'), { recursive: true });
await fs.mkdir('../web/src/demo', { recursive: true });
await fs.writeFile('../web/src/demo/seed.json', JSON.stringify(out));
console.log(Object.entries(out).map(([k, v]) => `${k}:${v.length}`).join(' '));
await db.destroy();
