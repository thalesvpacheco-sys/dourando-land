import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { scoreMatch } from '@dl/shared';
import { createApp } from '../src/app.js';
import { db } from '../src/db/knex.js';
import { seed } from '../src/db/seed.js';
import { signDevToken } from '../src/auth/auth.js';
import { config } from '../src/config.js';
import { parseNaturalQuery } from '../src/routes/ai.js';

const app = createApp();
let S: Awaited<ReturnType<typeof seed>>;
const tokens: Record<string, string> = {};

async function tokenFor(email: string) {
  const u = await db('users').where({ email }).first();
  return signDevToken({ sub: u.external_id, org: u.org_id, role: u.role, name: u.name, email: u.email, amr: ['mfa'] });
}
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

beforeAll(async () => {
  S = await seed();
  for (const [k, e] of Object.entries({
    admin: 'marina@dourado.example', captacao: 'carlos@dourado.example', juliana: 'juliana@parceiros.example', felipe: 'felipe@parceiros.example',
    owner: 'antonio.proprietario@example.com', buyer: 'lucas@horizonte.example', platform: 'ana@wingsbr.example', outra: 'paulo@outra.example',
  })) tokens[k] = await tokenFor(e);
});
afterAll(async () => { await db.destroy(); });

const square = (lat: number, lng: number, side: number) => {
  const dLat = side / 2 / 111320, dLng = side / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return { type: 'Polygon', coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]] };
};

// =====================================================================================================
describe('Critérios de aceite (seção 20)', () => {
  let oppId = '', code = '', slug = '', version = 0;

  it('1. administrador cadastra área com imagens, condições e localização', async () => {
    const c = await request(app).post('/api/opportunities').set(as('admin')).send({ internal_name: 'Teste — Gleba Bela Vista', type: 'loteamento', uf: 'GO', city: 'Bela Vista de Goiás' });
    expect(c.status).toBe(201);
    expect(c.body.code).toMatch(/^DOU-GO-\d{4}$/);
    oppId = c.body.id; code = c.body.code; version = c.body.version;

    const p = await request(app).patch(`/api/opportunities/${oppId}`).set(as('admin')).send({
      version, draft_step: 4,
      fields: { public_title: 'Gleba para loteamento em Bela Vista', area_m2: 250000, status: 'qualificada', summary: 'Gleba plana.' },
      terms: { modalities: ['venda', 'permuta_fisica'], asking_price: 9_000_000, swap_pct: 30, commission_total_pct: 6, internal_notes: 'NOTA-INTERNA-SECRETA' },
      publication: { show_price: true, show_price_per_m2: true, location_precision: 'approximate' },
      technical: { viabilidade: { value: ['loteamento'], source: 'Estudo interno', validation_status: 'verificado' }, agua: { value: true, source: 'Concessionária', validation_status: 'oficial' } },
    });
    expect(p.status).toBe(200);
    version = p.body.version;

    // rascunho automático com versão antiga é recusado (bloqueio otimista)
    const stale = await request(app).patch(`/api/opportunities/${oppId}`).set(as('admin')).send({ version: version - 1, fields: { summary: 'x' } });
    expect(stale.status).toBe(409);

    const g = await request(app).put(`/api/opportunities/${oppId}/geometry`).set(as('admin')).send({ geojson: square(-16.97, -48.95, 500), source: 'draw' });
    expect(g.status).toBe(200);
    expect(g.body.area_m2).toBeGreaterThan(247500);
    expect(g.body.area_m2).toBeLessThan(252500); // geodésico (elipsoide), ~250.000 m² ±1%

    const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#8a9a5b' } }).png().toBuffer();
    const m = await request(app).post(`/api/opportunities/${oppId}/media`).set(as('admin')).attach('files', png, 'foto.png');
    expect(m.status).toBe(201);
    expect(m.body.items[0].storage_key).toMatch(/\.webp$/);

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const d = await request(app).post(`/api/opportunities/${oppId}/documents`).set(as('admin'))
      .field('category', 'authorization').field('title', 'Autorização de divulgação').field('confidentiality', 'confidential').attach('file', pdf, 'autorizacao.pdf');
    expect(d.status).toBe(201);

    await request(app).post(`/api/opportunities/${oppId}/owners`).set(as('admin')).send({ kind: 'pf', name: 'PROPRIETARIO-SIGILOSO', document: '123.456.789-00' }).expect(201);
    await request(app).post(`/api/opportunities/${oppId}/assignments`).set(as('admin')).send({ broker_id: S.brokers[0].id, role: 'primary' }).expect(201);

    const full = await request(app).get(`/api/opportunities/${oppId}`).set(as('admin'));
    expect(full.body.checklist).toEqual([]);
    expect(full.body.owners[0].document).toBe('123.456.789-00'); // decifrado só para quem pode
    const raw = await db('land_owners').where({ opportunity_id: oppId }).first();
    expect(raw.document_enc).not.toContain('123.456'); // cifrado em repouso
  });

  it('2. área passa por aprovação e é publicada (captação envia, só admin aprova)', async () => {
    expect((await request(app).get(`/api/public/opportunities/${code.toLowerCase()}`)).status).toBe(404); // ainda não publicada
    const sub = await request(app).post(`/api/opportunities/${oppId}/submit-review`).set(as('captacao'));
    expect(sub.body).toEqual({ publication_status: 'pending_review' });
    expect((await request(app).post(`/api/opportunities/${oppId}/review`).set(as('captacao')).send({ decision: 'approve' })).status).toBe(403);
    const r = await request(app).post(`/api/opportunities/${oppId}/review`).set(as('admin')).send({ decision: 'approve' });
    expect(r.body.publication_status).toBe('published');
    const o = await db('land_opportunities').where({ id: oppId }).first();
    slug = o.slug;
    expect(o.status).toBe('disponivel');
    expect(await db('audit_logs').where({ entity_id: oppId, action: 'publication.approve' }).first()).toBeTruthy();
  });

  it('2b. cadastro sem autorização de divulgação não pode ir para revisão', async () => {
    const c = await request(app).post('/api/opportunities').set(as('admin')).send({ internal_name: 'Sem autorização', type: 'gleba', uf: 'GO', city: 'Inhumas' });
    const r = await request(app).post(`/api/opportunities/${c.body.id}/submit-review`).set(as('admin'));
    expect(r.status).toBe(400);
    expect(r.body.details.missing).toContain('Autorização de divulgação (documento ou base jurídica)');
  });

  it('3. visitante pesquisa e filtra oportunidades', async () => {
    const all = await request(app).get('/api/public/opportunities');
    expect(all.body.items.map((i: any) => i.code)).toContain(code);
    const f = await request(app).get('/api/public/opportunities').query({ uf: 'GO', area_min: 200000, area_max: 300000, modality: 'permuta_fisica', viability: 'loteamento', infra: 'agua' });
    expect(f.body.items.map((i: any) => i.code)).toContain(code);
    const none = await request(app).get('/api/public/opportunities').query({ uf: 'MG', city: 'Bela Vista de Goiás' });
    expect(none.body.total).toBe(0);
    const price = await request(app).get('/api/public/opportunities').query({ price_max: 9_500_000, price_min: 8_500_000 });
    expect(price.body.items.map((i: any) => i.code)).toContain(code);
    const map = await request(app).get('/api/public/map').query({ uf: 'GO' });
    expect(map.body.features.some((f: any) => f.properties.code === code)).toBe(true);
  });

  it('4. visitante visualiza a página individual (URL amigável; slug antigo continua resolvendo)', async () => {
    const r = await request(app).get(`/api/public/opportunities/${slug}`);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Gleba para loteamento em Bela Vista');
    expect(r.body.media.length).toBe(1);
    const alt = await request(app).get(`/api/public/opportunities/${code.toLowerCase()}-titulo-antigo`);
    expect(alt.body.canonical_slug).toBe(slug);
  });

  it('5. sistema respeita campos confidenciais', async () => {
    const r = await request(app).get(`/api/public/opportunities/${slug}`);
    const s = JSON.stringify(r.body);
    expect(s).not.toContain('PROPRIETARIO-SIGILOSO');
    expect(s).not.toContain('NOTA-INTERNA-SECRETA');
    expect(s).not.toContain('commission');
    expect(r.body.location.precision).toBe('approximate');
    expect(r.body.location.polygon).toBeUndefined();
    expect(r.body.address).toBeNull();
    // ponto público é deslocado do centróide real
    const g = await db('land_geometries').where({ opportunity_id: oppId, is_current: true }).select(db.raw('ST_Distance(centroid::geography, public_point::geography) as d')).first();
    expect(g.d).toBeGreaterThan(50);
    // ocultar preço
    const o = await db('land_opportunities').where({ id: oppId }).first();
    await request(app).patch(`/api/opportunities/${oppId}`).set(as('admin')).send({ version: o.version, publication: { show_price: false, show_price_per_m2: false } }).expect(200);
    const hidden = await request(app).get(`/api/public/opportunities/${slug}`);
    expect(hidden.body.commercial.asking_price).toBeNull();
    expect(hidden.body.commercial.price_hidden).toBe(true);
    // filtro por preço não revela áreas com preço oculto
    const leak = await request(app).get('/api/public/opportunities').query({ price_min: 8_500_000, price_max: 9_500_000 });
    expect(leak.body.items.map((i: any) => i.code)).not.toContain(code);
    // documentos confidenciais não aparecem na vitrine
    expect(hidden.body.documents.every((d: any) => d.title !== 'Autorização de divulgação')).toBe(true);
  });

  let token = '';
  it('6. botão WhatsApp carrega o contexto correto', async () => {
    const r = await request(app).post(`/api/public/opportunities/${slug}/interest`).send({ kind: 'whatsapp', attribution: { utm_source: 'google', gclid: 'abc' } });
    expect(r.status).toBe(201);
    token = r.body.token;
    expect(token).toMatch(/^DL-[A-Z0-9]{6}$/);
    const url = new URL(r.body.whatsapp_url);
    expect(url.hostname).toBe('wa.me');
    expect(url.pathname).toBe('/5562999110001'); // intermediadora atribuída (regra GO)
    const text = url.searchParams.get('text')!;
    expect(text).toContain(code);
    expect(text).toContain('Gleba para loteamento em Bela Vista');
    expect(text).toContain('Bela Vista de Goiás/GO');
    expect(text).toContain('25 ha');
    expect(text).toContain(`Referência: ${token}`);
    const i = await db('opportunity_interests').where({ intent_token: token }).first();
    expect(i.status).toBe('clicked'); // clique ≠ conversa
    expect(i.channel).toBe('google_ads');
    expect(i.crm_sync_status).toBe('not_applicable'); // anônimo não vai ao CRM
  });

  let negotiationId = '';
  it('7. interesse fica registrado no CRM (com consentimento e deduplicação)', async () => {
    const noConsent = await request(app).post(`/api/public/opportunities/${slug}/interest`).send({ kind: 'form', name: 'Rita', email: 'rita@example.com' });
    expect(noConsent.status).toBe(400);
    const r = await request(app).post(`/api/public/opportunities/${slug}/interest`).send({ kind: 'form', name: 'Rita Campos', email: 'Rita@Example.com', phone: '(62) 98888-7777', company: 'Construtora Teste', consent: true, message: 'Quero o book' });
    expect(r.status).toBe(201);
    expect(r.body.crm.status).toBe('synced');
    expect(r.body.crm.contact_id).toMatch(/^emb_/);
    const r2 = await request(app).post(`/api/public/opportunities/${slug}/interest`).send({ kind: 'whatsapp', name: 'Rita C.', email: 'rita@example.com', consent: true });
    expect(r2.body.crm.contact_id).toBe(r.body.crm.contact_id); // mesmo contato, sem duplicar
    const i = await db('opportunity_interests').where({ intent_token: r.body.token }).first();
    expect(i.negotiation_id).toBeTruthy();
    expect(i.legal_basis).toBe('consentimento');
    negotiationId = i.negotiation_id;
    const lead = await db('crm_outbox').where({ idempotency_key: `lead:${i.id}` }).first();
    expect(lead.payload.opportunity_code).toBe(code);
    expect(lead.payload.attribution).toBeDefined();
  });

  it('8. intermediador recebe a oportunidade conforme regra configurada (atribuído, rodízio e fallback central)', async () => {
    // GO → intermediadora atribuída
    const i = await db('opportunity_interests').where({ intent_token: token }).first();
    expect(i.broker_id).toBe(S.brokers[0].id);
    expect(i.routed_via).toContain('Goiás');
    // DF → rodízio entre Felipe e Beatriz
    const df = S.opps.find((o: any) => o.uf === 'DF');
    const a = await request(app).post(`/api/public/opportunities/${df.slug}/interest`).send({ kind: 'whatsapp' });
    const b = await request(app).post(`/api/public/opportunities/${df.slug}/interest`).send({ kind: 'whatsapp' });
    expect(a.body.routed_to).not.toBe(b.body.routed_to);
    expect([a.body.routed_to, b.body.routed_to].sort()).toEqual(['Beatriz Lemos', 'Felipe Rocha']);
    // MG (sem regra de UF) → regra "Demais → central"
    const mg = S.opps.find((o: any) => o.uf === 'MG');
    const c = await request(app).post(`/api/public/opportunities/${mg.slug}/interest`).send({ kind: 'whatsapp' });
    expect(c.body.whatsapp_url).toContain('wa.me/5562900000000');
    // intermediadora vê o interesse no painel dela; outro intermediador não
    const mine = await request(app).get('/api/interests').set(as('juliana'));
    expect(mine.body.items.some((x: any) => x.intent_token === token)).toBe(true);
    const other = await request(app).get('/api/interests').set(as('felipe'));
    expect(other.body.items.some((x: any) => x.intent_token === token)).toBe(false);
    // transferência manual com histórico
    await request(app).post(`/api/interests/${i.id}/reassign`).set(as('admin')).send({ broker_id: S.brokers[1].id, reason: 'Férias' }).expect(200);
    expect(await db('interest_events').where({ interest_id: i.id, type: 'reassigned' }).first()).toBeTruthy();
  });

  it('9. equipe acompanha a negociação (etapas, atividades, conflito de edição)', async () => {
    const n = await request(app).get(`/api/negotiations/${negotiationId}`).set(as('juliana'));
    expect(n.status).toBe(200);
    expect(n.body.stage).toBe('interesse_recebido');
    await request(app).post(`/api/negotiations/${negotiationId}/activities`).set(as('juliana')).send({ type: 'call', subject: 'Primeiro contato' }).expect(201);
    const u = await request(app).patch(`/api/negotiations/${negotiationId}`).set(as('juliana')).send({ version: n.body.version, stage: 'apresentacao' });
    expect(u.status).toBe(200);
    expect((await request(app).patch(`/api/negotiations/${negotiationId}`).set(as('admin')).send({ version: n.body.version, stage: 'proposta' })).status).toBe(409);
    expect((await request(app).patch(`/api/negotiations/${negotiationId}`).set(as('admin')).send({ version: u.body.version, status: 'lost' })).status).toBe(400); // exige motivo
    const list = await request(app).get('/api/negotiations').set(as('admin'));
    expect(list.body.items.find((x: any) => x.id === negotiationId).stage).toBe('apresentacao');
    const i = await db('opportunity_interests').where({ negotiation_id: negotiationId }).first();
    expect(i.first_response_at).toBeTruthy(); // SLA marcado pela 1ª interação
  });

  it('10. proposta é cadastrada e versionada; aceite exige aprovação interna', async () => {
    const p = await request(app).post(`/api/negotiations/${negotiationId}/proposals`).set(as('juliana')).send({ acquisition_value: 8_200_000, swap_pct: 25, payment_schedule: [{ label: 'Sinal', amount: 820000 }], valid_until: '2026-12-31' });
    expect(p.status).toBe(201);
    const v2 = await request(app).post(`/api/proposals/${p.body.id}/versions`).set(as('admin')).send({ side: 'vendedor', acquisition_value: 8_800_000, swap_pct: 28 });
    expect(v2.body.version).toBe(2);
    expect((await request(app).post(`/api/proposals/${p.body.id}/status`).set(as('juliana')).send({ status: 'accepted' })).status).toBe(400);
    await request(app).post(`/api/proposals/${p.body.id}/approval`).set(as('admin')).send({ decision: 'approved' }).expect(200);
    await request(app).post(`/api/proposals/${p.body.id}/status`).set(as('juliana')).send({ status: 'accepted' }).expect(200);
    const n = await request(app).get(`/api/negotiations/${negotiationId}`).set(as('admin'));
    const prop = n.body.proposals.find((x: any) => x.id === p.body.id);
    expect(prop.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(prop.versions[0].side).toBe('vendedor');
    expect(n.body.stage).toBe('proposta'); // avançou automaticamente
  });

  it('11. dashboard reflete os dados persistidos', async () => {
    const d = await request(app).get('/api/dashboard').set(as('admin'));
    const total = await db('land_opportunities').where({ org_id: S.dourado.id }).count({ n: '*' }).first();
    expect(d.body.areas.total).toBe(Number(total!.n));
    const interests = await db('opportunity_interests').where({ org_id: S.dourado.id }).andWhere('created_at', '>=', db.raw(`now() - interval '90 days'`)).count({ n: '*' }).first();
    expect(d.body.interests.total).toBe(Number(interests!.n));
    const active = await db('negotiations').where({ org_id: S.dourado.id, status: 'open' }).count({ n: '*' }).first();
    expect(d.body.negotiations.active).toBe(Number(active!.n));
    expect(d.body.commission.realized).toBeGreaterThan(0);
    // captação não vê comissões no dashboard
    const c = await request(app).get('/api/dashboard').set(as('captacao'));
    expect(c.body.commission).toBeNull();
  });
});

// =====================================================================================================
describe('12. Permissões impedem acesso indevido', () => {
  it('intermediador só vê áreas atribuídas (IDOR → 404)', async () => {
    const notMine = S.opps.find((o: any) => o.cfg.broker === 1);
    expect((await request(app).get(`/api/opportunities/${notMine.id}`).set(as('juliana'))).status).toBe(404);
    const list = await request(app).get('/api/opportunities').set(as('juliana'));
    expect(list.body.items.every((o: any) => o.broker_id === S.brokers[0].id)).toBe(true);
    const mine = S.opps.find((o: any) => o.cfg.broker === 0);
    const r = await request(app).get(`/api/opportunities/${mine.id}`).set(as('juliana'));
    expect(r.status).toBe(200);
    expect(r.body.owners).toEqual([]); // sem dados do proprietário
    expect(r.body.terms.commission_total_pct).toBeUndefined();
    expect(r.body.geometry.geometry).toBeNull(); // sem perímetro exato
    expect((await request(app).patch(`/api/opportunities/${mine.id}`).set(as('juliana')).send({ version: 1, fields: { summary: 'x' } })).status).toBe(403);
  });

  it('proprietário vê apenas as próprias áreas e envia documentos', async () => {
    const list = await request(app).get('/api/opportunities').set(as('owner'));
    expect(list.body.items.length).toBe(2);
    const own = list.body.items[0];
    const pdf = Buffer.from('%PDF-1.4\n%%EOF');
    const up = await request(app).post(`/api/opportunities/${own.id}/documents`).set(as('owner')).field('category', 'iptu_itr').field('title', 'IPTU 2026').field('confidentiality', 'public').attach('file', pdf, 'iptu.pdf');
    expect(up.status).toBe(201);
    expect(up.body.confidentiality).toBe('confidential'); // reclassificado
    const other = S.opps[5];
    expect((await request(app).get(`/api/opportunities/${other.id}`).set(as('owner'))).status).toBe(404);
  });

  it('comprador vê vitrine pública + privada, mas não rascunhos nem dados internos', async () => {
    const draft = S.opps.find((o: any) => o.cfg.pub === 'draft');
    expect((await request(app).get(`/api/opportunities/${draft.id}`).set(as('buyer'))).status).toBe(404);
    const priv = S.opps.find((o: any) => o.cfg.visibility === 'private');
    expect((await request(app).get(`/api/public/opportunities/${priv.slug}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/opportunities/${priv.slug}`).set(as('buyer'))).status).toBe(200);
    expect((await request(app).post('/api/opportunities').set(as('buyer')).send({ internal_name: 'x', type: 'gleba', uf: 'GO', city: 'x' })).status).toBe(403);
    const negs = await request(app).get('/api/negotiations').set(as('buyer'));
    expect(negs.body.items.length).toBe(2);
    expect(negs.body.items.every((n: any) => n.partner_name === 'Construtora Horizonte (fictícia)')).toBe(true);
    const profiles = await request(app).get('/api/profiles').set(as('buyer'));
    expect(profiles.body.items.map((p: any) => p.partner_name)).toEqual(['Construtora Horizonte (fictícia)']);
  });

  it('isolamento entre organizações', async () => {
    const dou = S.opps[0];
    expect((await request(app).get(`/api/opportunities/${dou.id}`).set(as('outra'))).status).toBe(404);
    expect((await request(app).get(`/api/opportunities/${S.foreign.id}`).set(as('admin'))).status).toBe(404);
    const list = await request(app).get('/api/opportunities').set(as('outra'));
    expect(list.body.items.map((o: any) => o.code)).toEqual(['OUT-SP-0001']);
    const negs = await request(app).get('/api/negotiations').set(as('outra'));
    expect(negs.body.items).toEqual([]);
  });

  it('superadministrador WingsBr não tem acesso comercial por padrão', async () => {
    expect((await request(app).get('/api/opportunities').set(as('platform'))).status).toBe(403);
    expect((await request(app).get('/api/negotiations').set(as('platform'))).status).toBe(403);
    expect((await request(app).get('/api/admin/users').set(as('platform'))).status).toBe(200);
  });

  it('documentos só por URL temporária assinada e conforme confidencialidade', async () => {
    const doc = await db('land_documents').where({ opportunity_id: S.opps[0].id, category: 'matricula' }).first();
    expect((await request(app).get(`/api/documents/${doc.id}/url`).set(as('juliana'))).status).toBe(404); // confidencial
    const ok = await request(app).get(`/api/documents/${doc.id}/url`).set(as('admin'));
    expect(ok.status).toBe(200);
    const file = await request(app).get(ok.body.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    const tampered = ok.body.url.slice(0, -4) + 'AAAA';
    expect((await request(app).get(tampered)).status).toBe(404);
    expect((await request(app).get(`/api/public/documents/${doc.id}/url`)).status).toBe(404);
  });

  it('token inválido, sem MFA para perfil privilegiado e upload malicioso', async () => {
    expect((await request(app).get('/api/opportunities').set({ Authorization: 'Bearer abc' })).status).toBe(401);
    (config as any).requireMfa = true;
    const u = await db('users').where({ email: 'marina@dourado.example' }).first();
    const noMfa = signDevToken({ sub: u.external_id, org: u.org_id, role: u.role, name: u.name, email: u.email, amr: ['pwd'] });
    expect((await request(app).get('/api/opportunities').set({ Authorization: `Bearer ${noMfa}` })).status).toBe(401);
    (config as any).requireMfa = false;
    const evil = await request(app).post(`/api/opportunities/${S.opps[0].id}/documents`).set(as('admin'))
      .field('category', 'outro').field('title', 'x').attach('file', Buffer.from('<html><script>alert(1)</script></html>'), 'contrato.pdf');
    expect(evil.status).toBe(400);
    const fakeImg = await request(app).post(`/api/opportunities/${S.opps[0].id}/media`).set(as('admin')).attach('files', Buffer.from('not an image'), 'foto.jpg');
    expect(fakeImg.status).toBe(400);
  });
});

// =====================================================================================================
describe('WhatsApp Business Platform — webhook', () => {
  const sign = (body: string) => `sha256=${crypto.createHmac('sha256', config.waAppSecret).update(body).digest('hex')}`;
  const payload = (id: string, text: string) => JSON.stringify({ entry: [{ changes: [{ value: { metadata: { display_phone_number: '5562999110001' }, messages: [{ id, from: '5562977776666', timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text } }] } }] }] });

  it('verificação do webhook (hub.challenge)', async () => {
    const r = await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': config.waVerifyToken, 'hub.challenge': '42' });
    expect(r.text).toBe('42');
  });

  it('rejeita assinatura inválida; vincula por token; sem token fica para vínculo manual; reentrega é idempotente', async () => {
    const opp = S.opps[0];
    const click = await request(app).post(`/api/public/opportunities/${opp.slug}/interest`).send({ kind: 'whatsapp' });
    const body = payload('wamid.T1', `Olá! Tenho interesse... Referência: ${click.body.token}.`);
    expect((await request(app).post('/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', 'sha256=00').send(body)).status).toBe(401);
    const ok = await request(app).post('/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(body)).send(body);
    expect(ok.body.processed).toBe(1);
    const i = await db('opportunity_interests').where({ intent_token: click.body.token }).first();
    expect(i.status).toBe('message_received');
    const types = (await db('interest_events').where({ interest_id: i.id })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['click', 'conversation_started', 'message_received']));
    const again = await request(app).post('/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(body)).send(body);
    expect(again.body.processed).toBe(0);
    // usuário apagou a mensagem pré-preenchida: não há associação automática
    const free = payload('wamid.T2', 'Oi, quero saber de terrenos');
    await request(app).post('/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(free)).send(free).expect(200);
    const m = await db('whatsapp_inbound').where({ wa_message_id: 'wamid.T2' }).first();
    expect(m.link_status).toBe('unlinked');
    expect(m.interest_id).toBeNull();
    expect(m.from_masked).toBe('*********6666');
  });
});

// =====================================================================================================
describe('Comissões, geo, matching e IA', () => {
  it('comissão não se torna devida sem contrato e evento', async () => {
    const neg = await db('negotiations').where({ org_id: S.dourado.id, stage: 'due_diligence' }).first();
    const c = await db('commissions').where({ negotiation_id: neg.id, status: 'prevista' }).first();
    const noDoc = await request(app).post(`/api/proposals/commissions/${c.id}/transition`).set(as('admin')).send({ to: 'contratada' });
    expect(noDoc.status).toBe(400);
    const doc = await db('land_documents').where({ opportunity_id: neg.opportunity_id, category: 'contrato_intermediacao' }).first();
    await request(app).post(`/api/proposals/commissions/${c.id}/transition`).set(as('admin')).send({ to: 'contratada', contract_document_id: doc.id }).expect(200);
    const early = await request(app).post(`/api/proposals/commissions/${c.id}/transition`).set(as('admin')).send({ to: 'exigivel', note: 'x' });
    expect(early.status).toBe(400); // negociação ainda em due diligence
    expect((await request(app).post(`/api/proposals/commissions/${c.id}/transition`).set(as('admin')).send({ to: 'paga' })).status).toBe(409);
    const broker = await request(app).get(`/api/negotiations/${neg.id}`).set(as('juliana'));
    expect(broker.body.commissions.every((x: any) => x.broker_id === S.brokers[0].id)).toBe(true); // só a própria
  });

  it('importa KML e calcula área geodésica', async () => {
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>
      -49.30,-16.70 -49.29,-16.70 -49.29,-16.69 -49.30,-16.69 -49.30,-16.70</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    const opp = S.opps[10];
    const r = await request(app).post(`/api/opportunities/${opp.id}/geometry/import`).set(as('captacao')).attach('file', Buffer.from(kml), 'area.kml');
    expect(r.status).toBe(200);
    const g = await request(app).put(`/api/opportunities/${opp.id}/geometry`).set(as('captacao')).send({ geojson: r.body.geojson, source: 'kml' });
    // 0,01° × 0,01° a 16,7°S ≈ 1.066 km × 1.106 km ≈ 117,9 ha
    expect(g.body.area_m2 / 10000).toBeGreaterThan(117);
    expect(g.body.area_m2 / 10000).toBeLessThan(119);
    expect(g.body.version).toBe(2); // versão anterior preservada
  });

  it('matching determinístico e explicável; nunca infere dado ausente', () => {
    const r = scoreMatch(
      { ufs: ['GO'], cities: ['Goiânia'], min_area_m2: 10000, max_area_m2: 50000, typologies: ['verticalizacao'], budget_max: 30e6, modalities: ['venda'], max_swap_pct: null, min_approval_stage: 'estudo_preliminar', restrictions: { require_water: true } },
      { uf: 'GO', city: 'Goiânia', area_m2: 38500, asking_price: 24e6, modalities: ['venda'], swap_pct: null, tech: { viabilidade: { value: ['verticalizacao'], validation_status: 'declarado' }, agua: { value: true, validation_status: 'oficial' } } },
    );
    expect(r.criteria.find((c) => c.key === 'location')!.earned).toBe(25);
    expect(r.criteria.find((c) => c.key === 'typology')!.note).toContain('não verificada');
    expect(r.criteria.find((c) => c.key === 'approval')!.earned).toBe(0); // estágio não informado → 0, sem inferir
    const ex = scoreMatch({ ufs: [], cities: [], min_area_m2: null, max_area_m2: null, typologies: [], budget_max: null, modalities: [], max_swap_pct: null, min_approval_stage: null, restrictions: { require_sewer: true } },
      { uf: 'GO', city: 'X', area_m2: 1, asking_price: null, modalities: [], swap_pct: null, tech: { esgoto: { value: false, validation_status: 'oficial' } } });
    expect(ex.excluded).toBe(true);
    expect(ex.exclusions).toContain('Sem rede de esgoto');
  });

  it('recomendações persistidas para o comprador apenas em áreas publicadas', async () => {
    const r = await request(app).get('/api/matches').set(as('buyer'));
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((m: any) => m.publication_status === 'published' && m.partner_name.includes('Horizonte'))).toBe(true);
    expect(r.body.items[0].breakdown.criteria.length).toBe(6);
  });

  it('IA gera sugestões rotuladas, com origem registrada e sem inventar dados', async () => {
    const opp = S.opps[0];
    const d = await request(app).post(`/api/ai/opportunities/${opp.id}/description`).set(as('captacao'));
    expect(d.body.origin).toBe('heuristic');
    expect(d.body.label).toContain('Sugestão');
    expect(d.body.text).toContain('Goianira/GO');
    expect(await db('ai_suggestions').where({ id: d.body.id }).first()).toBeTruthy();
    const gaps = await request(app).get(`/api/ai/opportunities/${S.opps[11].id}/gaps`).set(as('captacao'));
    expect(gaps.body.items.some((g: any) => g.field === 'Zoneamento')).toBe(true);
    const q = parseNaturalQuery('áreas acima de 20 hectares para loteamento com permuta em GO');
    expect(q.filters).toMatchObject({ area_min: '200000', viability: 'loteamento', uf: 'GO' });
    expect(q.filters.modality).toContain('permuta_fisica');
  });

  it('privacidade: anonimização a pedido do titular', async () => {
    const r = await request(app).post('/api/privacy/erase').set(as('admin')).send({ email: 'rita@example.com', reason: 'Solicitação do titular' });
    expect(r.body.interests).toBeGreaterThan(0);
    expect(await db('opportunity_interests').where({ email: 'rita@example.com' }).first()).toBeUndefined();
  });
});
