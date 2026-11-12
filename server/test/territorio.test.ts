/** Bases territoriais carregadas no PostGIS: importação, busca, análise ambiental, radar, DXF e leitura de matrícula. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCoordinates, utmToLatLng } from '@dl/shared';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { db } from '../src/db/knex.js';
import { seed } from '../src/db/seed.js';
import { signDevToken } from '../src/auth/auth.js';
import { importShapefile } from '../src/integrations/territory-cli.js';

const app = createApp();
let S: Awaited<ReturnType<typeof seed>>;
const T: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${T[k]}` });

/** Shapefile mínimo (.shp, .shx, .dbf) escrito à mão, para testar o leitor sem base oficial. */
async function writeShp(dir: string, name: string, feats: { ring: number[][]; props: Record<string, string | number> }[]) {
  const fields = Object.keys(feats[0].props);
  const content = feats.map((f) => {
    const n = f.ring.length;
    const b = Buffer.alloc(44 + 4 + 16 * n);
    b.writeInt32LE(5, 0);
    const xs = f.ring.map((c) => c[0]), ys = f.ring.map((c) => c[1]);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => b.writeDoubleLE(v, 4 + i * 8));
    b.writeInt32LE(1, 36); b.writeInt32LE(n, 40); b.writeInt32LE(0, 44);
    f.ring.forEach(([x, y], i) => { b.writeDoubleLE(x, 48 + i * 16); b.writeDoubleLE(y, 56 + i * 16); });
    return b;
  });
  const header = (len: number) => {
    const h = Buffer.alloc(100);
    h.writeInt32BE(9994, 0); h.writeInt32BE(len / 2, 24); h.writeInt32LE(1000, 28); h.writeInt32LE(5, 32);
    return h;
  };
  const recs = content.map((c, i) => { const r = Buffer.alloc(8); r.writeInt32BE(i + 1, 0); r.writeInt32BE(c.length / 2, 4); return Buffer.concat([r, c]); });
  const shpBody = Buffer.concat(recs);
  await fs.writeFile(path.join(dir, `${name}.shp`), Buffer.concat([header(100 + shpBody.length), shpBody]));
  const shx: Buffer[] = []; let off = 100;
  for (const r of recs) { const e = Buffer.alloc(8); e.writeInt32BE(off / 2, 0); e.writeInt32BE((r.length - 8) / 2, 4); shx.push(e); off += r.length; }
  await fs.writeFile(path.join(dir, `${name}.shx`), Buffer.concat([header(100 + shx.length * 8), ...shx]));
  const W = 80;
  const head = Buffer.alloc(32 + fields.length * 32 + 1);
  head[0] = 3; head.writeUInt32LE(feats.length, 4); head.writeUInt16LE(head.length, 8); head.writeUInt16LE(1 + W * fields.length, 10);
  fields.forEach((f, i) => { head.write(f.slice(0, 10), 32 + i * 32, 'ascii'); head[32 + i * 32 + 11] = 67; head[32 + i * 32 + 16] = W; });
  head[head.length - 1] = 13;
  const rows = feats.map((f) => { const r = Buffer.alloc(1 + W * fields.length, 32); fields.forEach((k, i) => r.write(String(f.props[k]), 1 + i * W, 'utf8')); return r; });
  await fs.writeFile(path.join(dir, `${name}.dbf`), Buffer.concat([head, ...rows, Buffer.from([0x1a])]));
  return path.join(dir, `${name}.shp`);
}
const box = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]];

let dir: string; let oppId: string;
beforeAll(async () => {
  S = await seed();
  for (const [k, e] of Object.entries({ admin: 'marina@dourado.example', captacao: 'carlos@dourado.example', juliana: 'juliana@parceiros.example', dono: 'antonio.proprietario@example.com' })) {
    const u = await db('users').where({ email: e }).first();
    T[k] = signDevToken({ sub: u.external_id, org: u.org_id, role: u.role, name: u.name, email: u.email, amr: ['mfa'] });
  }
  process.env.TERRITORY_MODE = 'live';
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shp-'));
  // parcelas fictícias numa região sem áreas do seed
  const P = (name: string, cod: string, ring: number[][], extra: any = {}) => ({ ring, props: { parcela_co: cod, nome_area: name, municipio_: 'Cidade Teste', situacao_i: 'Certificada', registro_m: '1234', ...extra } });
  const sigef = await writeShp(dir, 'sigef', [
    P('Fazenda Alfa', 'aaaaaaaa-1111', box(-50.10, -15.10, -50.08, -15.08)),
    P('Fazenda Beta', 'bbbbbbbb-2222', box(-50.06, -15.10, -50.04, -15.08)),
    P('Sítio Gama', 'cccccccc-3333', box(-50.02, -15.10, -50.018, -15.098)),
  ]);
  await importShapefile({ layer: 'sigef', uf: 'GO', file: sigef });
  // APP e Reserva Legal se sobrepõem de propósito dentro da Fazenda Alfa
  await importShapefile({ layer: 'car_app', uf: 'GO', file: await writeShp(dir, 'app', [{ ring: box(-50.10, -15.10, -50.09, -15.09), props: { nom_tema: 'APP' } }]) });
  await importShapefile({ layer: 'car_rl', uf: 'GO', file: await writeShp(dir, 'rl', [{ ring: box(-50.095, -15.095, -50.085, -15.085), props: { nom_tema: 'RL' } }]) });
  await importShapefile({ layer: 'embargo', uf: 'GO', file: await writeShp(dir, 'emb', [{ ring: box(-50.05, -15.09, -50.045, -15.085), props: { nome: 'Embargo fictício' } }]) });
});
afterAll(async () => { delete process.env.TERRITORY_MODE; await db.destroy(); });

describe('Coordenadas', () => {
  it('decimal, GMS e UTM (formatos do Brasil)', () => {
    expect(parseCoordinates('-16.68, -49.25')).toMatchObject({ lat: -16.68, lng: -49.25, format: 'decimal' });
    expect(parseCoordinates('-16,68; -49,25')).toMatchObject({ lat: -16.68, format: 'decimal' });
    const g = parseCoordinates(`16°40'48"S 49°15'00"W`)!;
    expect(g.lat).toBeCloseTo(-16.68, 4); expect(g.lng).toBeCloseTo(-49.25, 4);
    expect(parseCoordinates(`16°40'48"S 49°15'00"O`)!.lng).toBeCloseTo(-49.25, 4);
    // vetor do mapa do Geomart: UTM 23S 241.492 E 7.394.210 N ↔ Geo -23.541875
    const u = parseCoordinates('23S 241.492 7.394.210')!;
    expect(u.format).toBe('utm'); expect(u.lat).toBeCloseTo(-23.541875, 3);
    expect(parseCoordinates('Fazenda Alfa')).toBeNull();
    expect(parseCoordinates('10, 10')).toBeNull(); // fora do Brasil
    expect(parseCoordinates('SP-3552205-268351D4581A415DA6E5ED77849364A4')).toBeNull();
  });
  it('UTM confere com o PostGIS em todos os fusos do Brasil', async () => {
    for (const [zone, e, n] of [[19, 300000, 8900000], [22, 683000, 8155000], [23, 241492, 7394210], [24, 500000, 9000000], [25, 200000, 9200000]]) {
      const [lat, lng] = utmToLatLng(zone, e, n);
      const { rows } = await db.raw(`SELECT ST_Y(p) lat, ST_X(p) lng FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(?, ?), ?), 4674) p) x`, [e, n, 31960 + zone]);
      expect(lat).toBeCloseTo(rows[0].lat, 5); expect(lng).toBeCloseTo(rows[0].lng, 5);
    }
  });
});

describe('Bases carregadas', () => {
  it('importa, normaliza campos e substitui sem duplicar', async () => {
    const r = await db('territory_features').where({ layer: 'sigef' }).orderBy('code');
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ code: 'aaaaaaaa-1111', name: 'Fazenda Alfa', municipio: 'Cidade Teste', matricula: '1234', situacao: 'Certificada', uf: 'GO' });
    expect(r[0].area_ha).toBeGreaterThan(400); // área calculada pela geometria quando a base não traz
    const again = await writeShp(dir, 'sigef2', [{ ring: box(-50.10, -15.10, -50.08, -15.08), props: { parcela_co: 'aaaaaaaa-1111', nome_area: 'Fazenda Alfa', municipio_: 'Cidade Teste', situacao_i: 'Certificada', registro_m: '1234' } },
      { ring: box(-50.06, -15.10, -50.04, -15.08), props: { parcela_co: 'bbbbbbbb-2222', nome_area: 'Fazenda Beta', municipio_: 'Cidade Teste', situacao_i: 'Certificada', registro_m: '1234' } },
      { ring: box(-50.02, -15.10, -50.018, -15.098), props: { parcela_co: 'cccccccc-3333', nome_area: 'Sítio Gama', municipio_: 'Cidade Teste', situacao_i: 'Certificada', registro_m: '1234' } }]);
    await importShapefile({ layer: 'sigef', uf: 'GO', file: again });
    expect(await db('territory_features').where({ layer: 'sigef' }).count({ n: '*' }).first()).toMatchObject({ n: 3 });
  });
  it('recusa camada desconhecida e arquivo sem polígono não apaga a base anterior', async () => {
    await expect(importShapefile({ layer: 'xyz', uf: 'GO', file: 'a.shp' })).rejects.toThrow(/desconhecida/);
    await expect(importShapefile({ layer: 'sigef', uf: 'ZZ', file: 'a.shp' })).rejects.toThrow(/UF/);
    await expect(importShapefile({ layer: 'sigef', uf: 'GO', file: path.join(dir, 'nao-existe.shp') })).rejects.toThrow();
    expect(await db('territory_features').where({ layer: 'sigef' }).count({ n: '*' }).first()).toMatchObject({ n: 3 });
  });
  it('mapa mostra a camada carregada com fonte e data, sem nada fictício', async () => {
    const layers = (await request(app).get('/api/territory/layers').set(as('captacao'))).body;
    expect(layers.mode).toBe('live');
    expect(layers.layers.find((l: any) => l.key === 'sigef')).toMatchObject({ status: 'implemented', ufs: ['GO'], features: 3 });
    expect(layers.layers.find((l: any) => l.key === 'car').status).toBe('pending');
    const f = await request(app).get('/api/territory/features').query({ layer: 'sigef', bbox: '-50.2,-15.2,-50,-15' }).set(as('captacao'));
    expect(f.body.features).toHaveLength(3);
    expect(f.body.features[0].properties.ficticio).toBeUndefined();
    expect(f.body.features[0].properties.fonte).toMatch(/INCRA.*base carregada em/);
    const l = await request(app).get('/api/territory/lookup').query({ lat: -15.09, lng: -50.09, uf: 'GO' }).set(as('captacao'));
    expect(l.body.parcels.find((p: any) => p.properties?.layer === 'sigef').properties.nome).toBe('Fazenda Alfa');
    expect((await request(app).get('/api/territory/features').query({ layer: 'invalida', bbox: '0,0,1,1' }).set(as('captacao'))).status).toBe(400);
  });
  it('busca por código, matrícula, nome, coordenada e área interna; proprietário não acessa', async () => {
    const q = (s: string) => request(app).get('/api/territory/search').query({ q: s }).set(as('captacao'));
    expect((await q('AAAAAAAA-1111')).body.features[0].properties.nome).toBe('Fazenda Alfa');
    expect((await q('1234')).body.features).toHaveLength(3);
    expect((await q('Beta')).body.features[0].bbox).toHaveLength(4);
    expect((await q('-15.09, -50.09')).body.point).toMatchObject({ lat: -15.09 });
    expect((await q('DOU-GO-0001')).body.internal[0]).toMatchObject({ kind: 'opportunity', code: 'DOU-GO-0001' });
    expect((await q('%%%')).body.features).toHaveLength(0);
    expect((await request(app).get('/api/territory/search').query({ q: 'Beta' }).set(as('dono'))).status).toBe(403);
  });
});

describe('Análise ambiental e restrições', () => {
  it('desconta a união das camadas (sem contar a sobreposição duas vezes) e aponta restrição', async () => {
    const a = await request(app).post('/api/prospects').set(as('captacao')).send({
      title: 'Teste ambiental', source: 'mapa_territorial', land_type: 'gleba', uf: 'GO', city: 'Cidade Teste', territory: [], intended_uses: [],
      geojson: { type: 'Polygon', coordinates: [box(-50.10, -15.10, -50.08, -15.08)] },
    });
    expect(a.status).toBe(201);
    const env = (await request(app).get(`/api/prospects/${a.body.id}/environment`).set(as('captacao'))).body;
    const app_ = env.layers.find((l: any) => l.layer === 'car_app').area_m2, rl = env.layers.find((l: any) => l.layer === 'car_rl').area_m2;
    // APP (0,01° x 0,01°) e RL (0,01° x 0,01°) dividem 0,005° x 0,005°: a união é 1,75x a APP, não 2x
    expect(env.deducted_m2).toBeLessThan(app_ + rl - 1000);
    expect(env.deducted_m2 / app_).toBeCloseTo(1.75, 1);
    expect(env.usable_m2).toBeCloseTo(env.area_m2 - env.deducted_m2, 0);
    expect(env.restrictions).toHaveLength(0);
    expect(env.not_loaded.map((l: any) => l.layer)).toContain('terra_indigena');

    const b = await request(app).post('/api/prospects').set(as('captacao')).send({
      title: 'Teste embargo', source: 'mapa_territorial', land_type: 'gleba', uf: 'GO', city: 'Cidade Teste', territory: [], intended_uses: [],
      geojson: { type: 'Polygon', coordinates: [box(-50.06, -15.10, -50.04, -15.08)] },
    });
    const env2 = (await request(app).get(`/api/prospects/${b.body.id}/environment`).set(as('captacao'))).body;
    expect(env2.restrictions[0]).toMatchObject({ layer: 'embargo', count: 1 });
    expect(env2.restrictions[0].names).toContain('Embargo fictício');
    expect(env2.restrictions[0].area_m2).toBeGreaterThan(100000);
  });

  it('sem APP e Reserva Legal não calcula aproveitável: não entrega número enganoso', async () => {
    await db('territory_datasets').where({ layer: 'car_rl' }).del();
    const list = (await request(app).get('/api/prospects').query({ status: 'open' }).set(as('captacao'))).body.items;
    const p = list.find((x: any) => x.title === 'Teste ambiental');
    const env = (await request(app).get(`/api/prospects/${p.id}/environment`).set(as('captacao'))).body;
    expect(env.usable_m2).toBeNull();
    expect(env.usable_requires).toContain('Reserva Legal');
    await db('territory_datasets').insert({ layer: 'car_rl', uf: 'GO', source_name: 'rl', features: 1 });
  });

  it('área: análise respeita permissão de localização exata', async () => {
    const opp = S.opps[0];
    oppId = opp.id;
    expect((await request(app).get(`/api/opportunities/${opp.id}/environment`).set(as('admin'))).status).toBe(200);
    expect((await request(app).get(`/api/opportunities/${opp.id}/environment`).set(as('dono'))).status).toBe(403);
  });
});

describe('Radar de captação', () => {
  it('filtra por critério, tira o que já está no sistema e o que tem restrição', async () => {
    await db('land_prospects').where({ title: 'Teste embargo' }).del();
    const q = (o: any) => request(app).get('/api/territory/radar').query(o).set(as('captacao'));
    const names = (r: any) => r.body.items.map((i: any) => i.properties.nome).sort();
    // Alfa já é prospecção; Beta tem embargo; sobra Gama
    expect(names(await q({ uf: 'GO' }))).toEqual(['Sítio Gama']);
    expect(names(await q({ uf: 'GO', exclude_restrictions: '0' }))).toEqual(['Fazenda Beta', 'Sítio Gama']);
    expect(names(await q({ uf: 'GO', exclude_restrictions: '0', min_ha: 100 }))).toEqual(['Fazenda Beta']);
    expect(names(await q({ uf: 'GO', exclude_restrictions: '0', max_ha: 100 }))).toEqual(['Sítio Gama']);
    expect(names(await q({ uf: 'GO', municipio: 'cidade teste' }))).toEqual(['Sítio Gama']);
    expect(names(await q({ uf: 'GO', municipio: 'Outra' }))).toEqual([]);
    expect((await q({ uf: 'MG' })).body.loaded).toBe(false);
    expect((await q({})).status).toBe(400);
    const ok = await q({ uf: 'GO' });
    expect(ok.body.restrictions_checked).toContain('embargo');
    expect(ok.body.items[0].center).toHaveLength(2);
    expect((await request(app).get('/api/territory/radar').query({ uf: 'GO' }).set(as('dono'))).status).toBe(403);
  });
  it('parte de um perfil de aquisição e conta a demanda', async () => {
    const [org] = await db('organizations').where({ slug: 'dourado' });
    const [pc] = await db('partner_companies').where({ org_id: org.id }).limit(1);
    const [ap] = await db('acquisition_profiles').insert({ org_id: org.id, partner_company_id: pc.id, name: 'Perfil radar', ufs: ['GO'], cities: ['Cidade Teste'], min_area_m2: 1000, max_area_m2: 1000000, active: true }).returning('*');
    const r = await request(app).get('/api/territory/radar').query({ profile_id: ap.id, exclude_restrictions: '0' }).set(as('captacao'));
    expect(r.status).toBe(200);
    expect(r.body.filter.uf).toBe('GO');
    expect(r.body.items.map((i: any) => i.properties.nome)).toEqual(['Sítio Gama']); // só Gama cabe em até 100 ha
    expect(r.body.items[0].demand_count).toBeGreaterThanOrEqual(1);
  });
});

describe('Exportação', () => {
  it('DXF em UTM SIRGAS 2000 e KML da parcela, com auditoria', async () => {
    const f = await db('territory_features').where({ layer: 'sigef', code: 'aaaaaaaa-1111' }).first();
    const d = await request(app).get(`/api/territory/features/${f.id}/dxf`).set(as('captacao')).buffer(true).parse((res, cb) => { let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => cb(null, t)); });
    expect(d.status).toBe(200);
    expect(d.headers['content-disposition']).toMatch(/\.dxf/);
    const dxf = d.body as string;
    expect(dxf).toMatch(/SIRGAS2000_UTM22S/);
    const nums = [...dxf.matchAll(/\n {2}0\nVERTEX\n[\s\S]*?\n 10\n([\d.]+)\n 20\n([\d.]+)\n/g)];
    expect(nums).toHaveLength(4);
    expect(Number(nums[0][1])).toBeGreaterThan(100000); expect(Number(nums[0][2])).toBeGreaterThan(8000000); // metros, não graus
    expect(dxf.trim().endsWith('EOF')).toBe(true);
    const k = await request(app).get(`/api/territory/features/${f.id}/kml`).set(as('captacao')).buffer(true).parse((res, cb) => { let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => cb(null, t)); });
    expect(k.body).toContain('<Polygon>');
    expect((await request(app).get(`/api/territory/features/${f.id}/dxf`).set(as('dono'))).status).toBe(403);
    expect((await request(app).get(`/api/territory/features/999999/dxf`).set(as('captacao'))).status).toBe(404);
    expect((await request(app).get(`/api/opportunities/${oppId}/dxf`).set(as('admin'))).status).toBe(200);
    expect((await db('audit_logs').where({ action: 'export.dxf' }).count({ n: '*' }).first())!.n).toBeGreaterThanOrEqual(2);
    await fs.writeFile(process.env.DXF_OUT ?? path.join(dir, 'teste.dxf'), dxf);
  });
});

describe('Leitura de matrícula', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  it('sem chave informa o que falta; com chave devolve o resumo e não guarda o arquivo', async () => {
    (config as any).anthropicKey = null;
    expect((await request(app).post('/api/ai/matricula').set(as('captacao')).attach('file', pdf, 'm.pdf')).status).toBe(503);
    (config as any).anthropicKey = 'chave-de-teste';
    const orig = global.fetch;
    const body = { matricula: '31675', cartorio: '1º RI', imovel: 'Gleba B', proprietarios_atuais: ['Fulano'], atos: [{ ato: 'R.1', data: '2020', tipo: 'registro', resumo: 'Compra' }], onus_vigentes: ['Hipoteca'], pontos_de_atencao: [], transcricao: 'texto' };
    const fake = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(body) + '\n```' }] }), { status: 200 }));
    global.fetch = fake as any;
    try {
      const r = await request(app).post('/api/ai/matricula').set(as('captacao')).attach('file', pdf, 'm.pdf');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ matricula: '31675', onus_vigentes: ['Hipoteca'] });
      expect(r.body.aviso).toMatch(/Confira/);
      const sent = JSON.parse((fake.mock.calls[0] as any)[1].body);
      expect(sent.messages[0].content[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });
      expect((await request(app).post('/api/ai/matricula').set(as('captacao')).attach('file', Buffer.from('<html>'), 'm.pdf')).status).toBe(400);
      expect((await request(app).post('/api/ai/matricula').set(as('dono')).attach('file', pdf, 'm.pdf')).status).toBe(403);
    } finally { global.fetch = orig; (config as any).anthropicKey = null; }
  });
});
