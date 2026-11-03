import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { demoTerritoryFeatures, earthUrl, pointInGeometry, prospectScore, toKml } from '@dl/shared';
import { createApp } from '../src/app.js';
import { db } from '../src/db/knex.js';
import { seed } from '../src/db/seed.js';
import { signDevToken } from '../src/auth/auth.js';

const app = createApp();
let S: Awaited<ReturnType<typeof seed>>;
const T: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${T[k]}` });

beforeAll(async () => {
  S = await seed();
  for (const [k, e] of Object.entries({ admin: 'marina@dourado.example', captacao: 'carlos@dourado.example', juliana: 'juliana@parceiros.example', felipe: 'felipe@parceiros.example', buyer: 'lucas@horizonte.example', owner: 'antonio.proprietario@example.com' })) {
    const u = await db('users').where({ email: e }).first();
    T[k] = signDevToken({ sub: u.external_id, org: u.org_id, role: u.role, name: u.name, email: u.email, amr: ['mfa'] });
  }
});
afterAll(async () => { await db.destroy(); });

describe('Dados territoriais (modo demonstração)', () => {
  it('gerador fictício é determinístico e só responde em recortes pequenos', () => {
    const b: [number, number, number, number] = [-49.56, -16.53, -49.53, -16.50];
    const a1 = demoTerritoryFeatures('sigef', b), a2 = demoTerritoryFeatures('sigef', b);
    expect(a1.features.length).toBeGreaterThan(0);
    expect(JSON.stringify(a1)).toBe(JSON.stringify(a2));
    expect(a1.features.every((f: any) => f.properties.ficticio)).toBe(true);
    expect(demoTerritoryFeatures('car', [-50, -17, -49, -16]).tooLarge).toBe(true);
  });

  it('camadas, recorte e consulta de ponto com links ONR e Google Earth', async () => {
    const l = await request(app).get('/api/territory/layers').set(as('captacao'));
    expect(l.body.mode).toBe('demo');
    expect(l.body.registry.official_url).toBe('https://mapa.onr.org.br/');
    const f = await request(app).get('/api/territory/features').query({ layer: 'sigef', bbox: '-49.56,-16.53,-49.53,-16.50', uf: 'GO' }).set(as('captacao'));
    expect(f.body.features.length).toBeGreaterThan(0);
    const feat = f.body.features[0];
    const ring = feat.geometry.coordinates[0];
    const cx = ring.slice(0, -1).reduce((s: number, p: number[]) => s + p[0], 0) / (ring.length - 1);
    const cy = ring.slice(0, -1).reduce((s: number, p: number[]) => s + p[1], 0) / (ring.length - 1);
    expect(pointInGeometry([cx, cy], feat.geometry)).toBe(true);
    const lk = await request(app).get('/api/territory/lookup').query({ lat: cy, lng: cx, uf: 'GO' }).set(as('captacao'));
    expect(lk.body.parcels.some((p: any) => p.properties.codigo === feat.properties.codigo)).toBe(true);
    expect(lk.body.registry.matriculas.length).toBe(1);
    expect(lk.body.links.earth).toMatch(/^https:\/\/earth\.google\.com\/web\/@-16\.\d+,-49\.\d+,800a,\d+d,35y,0h,0t,0r$/);
    expect((await request(app).get('/api/territory/layers').set(as('buyer'))).status).toBe(403);
  });

  it('sobreposição da área com parcelas é calculada no PostGIS', async () => {
    const o = S.opps.find((x: any) => x.code === 'DOU-GO-0004');
    const r = await request(app).get(`/api/opportunities/${o.id}/overlap`).set(as('captacao'));
    expect(r.body.mode).toBe('demo');
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const i of r.body.items) { expect(i.pct_of_area).toBeGreaterThan(0); expect(i.pct_of_area).toBeLessThanOrEqual(100.01); }
  });

  it('exporta KML com o perímetro para o Google Earth', async () => {
    const o = S.opps[0];
    const r = await request(app).get(`/api/opportunities/${o.id}/kml`).set(as('admin'));
    expect(r.headers['content-type']).toContain('kml');
    expect(r.text).toContain('<Polygon>');
    expect(r.text).toContain(o.code);
    expect((await request(app).get(`/api/opportunities/${o.id}/kml`).set(as('juliana'))).status).toBe(403); // sem localização exata
    expect(toKml({ name: 'A & B', point: [-49, -16] })).toContain('A &amp; B');
    expect(earthUrl(-16.5, -49.25, 1000)).toBe('https://earth.google.com/web/@-16.500000,-49.250000,800a,1000d,35y,0h,0t,0r');
  });
});

describe('Captação de novas áreas', () => {
  let pid = '';
  it('cria prospecção a partir de uma parcela, com fonte e data dos dados', async () => {
    const f = (await request(app).get('/api/territory/features').query({ layer: 'sigef', bbox: '-49.35,-16.72,-49.32,-16.69', uf: 'GO' }).set(as('captacao'))).body.features[0];
    const r = await request(app).post('/api/prospects').set(as('captacao')).send({
      title: 'Teste captação Goiânia', source: 'mapa_territorial', land_type: 'gleba', uf: 'GO', city: 'Goiânia', intended_uses: ['verticalizacao'],
      geojson: f.geometry, territory: [{ layer: 'sigef', source: f.properties.fonte, consulted_at: new Date().toISOString(), properties: f.properties }],
    });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^CAP-\d{4}-\d{4}$/);
    pid = r.body.id;
    const d = await request(app).get(`/api/prospects/${pid}`).set(as('captacao'));
    expect(d.body.sigef_code).toBe(f.properties.codigo);
    expect(d.body.area_m2).toBeGreaterThan(10000);
    expect(d.body.territory_snapshot[0].properties.ficticio).toBe(true);
    expect(d.body.checklist.length).toBe(7);
    // demanda: Construtora Horizonte busca verticais em Goiânia
    expect(d.body.demand.some((x: any) => x.partner.includes('Horizonte'))).toBe(true);
    expect(d.body.score_items.find((x: any) => x.label === 'Perímetro').earned).toBe(10);
  });

  it('pré-qualificação é explicável e sobe com documentação e contato', async () => {
    const before = (await request(app).get(`/api/prospects/${pid}`).set(as('captacao'))).body;
    const checklist = before.checklist.map((c: any, i: number) => ({ ...c, status: i < 4 ? 'recebido' : c.status }));
    await request(app).patch(`/api/prospects/${pid}`).set(as('captacao')).send({ version: before.version, checklist, owner_name: 'Proprietário Teste', owner_phone: '62988887777', stage: 'documentacao' }).expect(200);
    const after = (await request(app).get(`/api/prospects/${pid}`).set(as('captacao'))).body;
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.owner_phone).toBe('5562988887777');
    expect(after.activities.some((a: any) => a.type === 'stage_change')).toBe(true);
    const stale = await request(app).patch(`/api/prospects/${pid}`).set(as('captacao')).send({ version: before.version, title: 'x x x' });
    expect(stale.status).toBe(409);
    const s = prospectScore({ demand: [], checklist: [], hasRegistry: false, hasOwnerContact: false, hasGeometry: false });
    expect(s.score).toBe(0);
  });

  it('converte em área do banco levando perímetro, proprietário e origem registral', async () => {
    const r = await request(app).post(`/api/prospects/${pid}/convert`).set(as('captacao'));
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^DOU-GO-\d{4}$/);
    const o = await request(app).get(`/api/opportunities/${r.body.opportunity_id}`).set(as('admin'));
    expect(o.body.status).toBe('captacao');
    expect(o.body.geometry.area_m2).toBeGreaterThan(10000);
    expect(o.body.owners[0].name).toBe('Proprietário Teste');
    expect(o.body.terms.internal_notes).toContain('SIGEF');
    expect(o.body.technical.situacao.validation_status).toBe('nao_verificado'); // dado fictício nunca vira oficial
    const p = (await request(app).get(`/api/prospects/${pid}`).set(as('captacao'))).body;
    expect(p.status).toBe('converted');
    expect((await request(app).post(`/api/prospects/${pid}/convert`).set(as('captacao'))).status).toBe(409);
  });

  it('não converte sem os dados mínimos', async () => {
    const r = await request(app).post('/api/prospects').set(as('captacao')).send({ title: 'Incompleta', source: 'prospeccao_ativa' });
    const c = await request(app).post(`/api/prospects/${r.body.id}/convert`).set(as('captacao'));
    expect(c.status).toBe(400);
    expect(c.body.details.missing).toEqual(expect.arrayContaining(['UF', 'Cidade', 'Proprietário']));
  });

  it('parceiro vê só as próprias indicações; comprador não acessa captação', async () => {
    const ind = await request(app).post('/api/prospects').set(as('juliana')).send({ title: 'Indicação da Juliana', uf: 'GO', city: 'Goiânia' });
    expect(ind.status).toBe(201);
    expect(ind.body.source).toBe('indicacao_parceiro');
    const mine = await request(app).get('/api/prospects').set(as('juliana'));
    expect(mine.body.items.map((p: any) => p.title)).toEqual(['Indicação da Juliana']);
    expect((await request(app).get('/api/prospects').set(as('felipe'))).body.items.some((p: any) => p.title === 'Indicação da Juliana')).toBe(false);
    expect((await request(app).get(`/api/prospects/${pid}`).set(as('juliana'))).status).toBe(404);
    expect((await request(app).post(`/api/prospects/${ind.body.id}/convert`).set(as('juliana'))).status).toBe(403);
    expect((await request(app).get('/api/prospects').set(as('buyer'))).status).toBe(403);
    expect((await request(app).get('/api/prospects').set(as('owner'))).status).toBe(403);
  });

  it('proprietário que oferece área pelo site entra no funil de captação', async () => {
    await request(app).post('/api/public/contact').send({ kind: 'proprietario', name: 'Dona Fictícia', phone: '62977776666', city: 'Itaberaí', message: '50 ha', consent: true }).expect(201);
    const l = await request(app).get('/api/prospects').set(as('captacao'));
    const p = l.body.items.find((x: any) => x.owner_name === 'Dona Fictícia');
    expect(p.source).toBe('site_proprietario');
    expect(p.city).toBe('Itaberaí');
  });

  it('dashboard mostra a captação', async () => {
    const d = await request(app).get('/api/dashboard').set(as('admin'));
    expect(d.body.prospects.open).toBeGreaterThan(5);
  });
});
