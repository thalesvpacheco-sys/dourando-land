/**
 * Dados FICTÍCIOS de demonstração. Nenhum nome, documento, telefone ou área corresponde a pessoas ou imóveis reais.
 * Imagens são ilustrações geradas (não fotografias). Recria o banco do zero — bloqueado em produção.
 */
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { db, migrationConfig } from './knex.js';
import { config } from '../config.js';
import { encrypt } from '../lib/crypto.js';
import { storage, newKey, sha256 } from '../lib/storage.js';
import { saveGeometry } from '../geo/geo.js';
import { buildSlug } from '../domain/opportunities.js';
import { MATRIX } from '../auth/permissions.js';
import { ROLES, demoTerritoryFeatures, pointInGeometry } from '@dl/shared';

if (config.isProd) throw new Error('Seed bloqueado em produção');

export async function resetDatabase() {
  await db.migrate.latest(migrationConfig);
  const { rows } = await db.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('knex_migrations','knex_migrations_lock','spatial_ref_sys')`);
  await db.raw(`TRUNCATE ${rows.map((r: any) => `"${r.tablename}"`).join(',')} RESTART IDENTITY CASCADE`);
}

// ------------------------------------------------------------------ helpers

function polygon(lat: number, lng: number, areaM2: number, aspect = 1.4, seed = 1) {
  const h = Math.sqrt(areaM2 / aspect), w = areaM2 / h;
  const dLat = h / 2 / 111320, dLng = w / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  const j = (k: number) => 1 + Math.sin(seed * 7.13 + k) * 0.06;
  const ring = [
    [lng - dLng * j(1), lat - dLat * j(2)], [lng + dLng * j(3), lat - dLat * j(4)], [lng + dLng * 1.08 * j(5), lat + dLat * 0.1],
    [lng + dLng * j(6), lat + dLat * j(7)], [lng - dLng * j(8), lat + dLat * j(9)], [lng - dLng * 1.05, lat + dLat * 0.05 * j(10)],
  ];
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Ilustração "aérea" gerada em SVG → WebP. Marcada como imagem ilustrativa. */
async function aerialImage(seed: number, variant: 'fields' | 'urban' | 'green') {
  const rnd = (n: number) => { const x = Math.sin(seed * 9301 + n * 49297) * 233280; return x - Math.floor(x); };
  const palettes = {
    fields: ['#b9a76f', '#a6995d', '#c7b682', '#8f9a58', '#d1c08f', '#9eaa66'],
    urban: ['#b8b2a4', '#a49d8e', '#c9c2b2', '#8e9a6a', '#d5cfbf', '#9aa178'],
    green: ['#6f8a4e', '#7f9a5a', '#5f7c45', '#90a865', '#a3b072', '#6b8550'],
  }[variant];
  let shapes = '';
  for (let i = 0; i < 26; i++) {
    const x = rnd(i) * 1600 - 200, y = rnd(i + 50) * 1000 - 150, w = 260 + rnd(i + 100) * 520, h = 180 + rnd(i + 150) * 420;
    const r = rnd(i + 200) * 40 - 20;
    shapes += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${palettes[i % palettes.length]}" opacity="0.92" transform="rotate(${r} ${x + w / 2} ${y + h / 2})"/>`;
    for (let k = 0; k < 6; k++) shapes += `<line x1="${x}" y1="${y + (h / 6) * k}" x2="${x + w}" y2="${y + (h / 6) * k}" stroke="#000" stroke-opacity="0.05" stroke-width="3" transform="rotate(${r} ${x + w / 2} ${y + h / 2})"/>`;
  }
  for (let i = 0; i < 40; i++) shapes += `<circle cx="${rnd(i + 300) * 1400}" cy="${rnd(i + 400) * 900}" r="${8 + rnd(i + 500) * 22}" fill="#4d6a3a" opacity="0.75"/>`;
  const road = `<path d="M -50 ${200 + rnd(7) * 500} C 400 ${rnd(8) * 900}, 900 ${rnd(9) * 900}, 1450 ${100 + rnd(10) * 700}" stroke="#e9e4d6" stroke-width="22" fill="none"/>
    <path d="M ${300 + rnd(11) * 700} -50 L ${200 + rnd(12) * 900} 950" stroke="#ddd6c4" stroke-width="12" fill="none"/>`;
  const plot = `<polygon points="${[0, 1, 2, 3, 4].map((k) => `${420 + Math.cos(k * 1.256 + rnd(k)) * (260 + rnd(k + 20) * 90)},${430 + Math.sin(k * 1.256 + rnd(k)) * (190 + rnd(k + 30) * 70)}`).join(' ')}" fill="#d4a63a" fill-opacity="0.16" stroke="#e8b84a" stroke-width="5" stroke-dasharray="18 10"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900"><rect width="1400" height="900" fill="${palettes[0]}"/>${shapes}${road}${plot}
    <rect x="1120" y="850" width="268" height="36" rx="4" fill="#000" fill-opacity="0.45"/><text x="1254" y="874" font-family="sans-serif" font-size="17" fill="#fff" text-anchor="middle">Imagem ilustrativa</text></svg>`;
  const data = await sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer();
  const key = newKey('media', 'webp');
  await storage.put(key, data);
  return key;
}

function tinyPdf(title: string) {
  const text = `(${title.replace(/[()\\]/g, '')} - DOCUMENTO FICTICIO DE DEMONSTRACAO)`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length + 40} >>\nstream\nBT /F1 14 Tf 60 760 Td ${text} Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(pdf);
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000);

// ------------------------------------------------------------------ dados

const AREAS = [
  { uf: 'GO', city: 'Goianira', region: 'Região Metropolitana de Goiânia', neighborhood: 'Setor Norte', lat: -16.4930, lng: -49.4260, area: 186000, type: 'incorporacao_vertical', title: 'Área para incorporação em Goianira', img: 'urban',
    viab: ['verticalizacao', 'condominio_horizontal'], stage: 'diretrizes_emitidas', zone: 'ZEU — Zona de Expansão Urbana', ca: 2.5, price: 18_500_000, mods: ['venda', 'permuta_fisica'], swap: 22, units: 640, vgv: 182_000_000, status: 'disponivel', pub: 'published', precision: 'approximate', featured: true, broker: 0, water: true, energy: true, sewer: true, created: 70 },
  { uf: 'GO', city: 'Goiânia', region: 'Região Sudoeste', neighborhood: 'Jardim Europa', lat: -16.7120, lng: -49.2950, area: 38500, type: 'terreno_urbano', title: 'Terreno urbano com vocação para uso misto', img: 'urban',
    viab: ['uso_misto', 'verticalizacao', 'comercial'], stage: 'estudo_preliminar', zone: 'Área Adensável', ca: 4, price: 24_000_000, mods: ['venda', 'permuta_financeira'], swap: 18, units: 420, vgv: 260_000_000, status: 'disponivel', pub: 'published', precision: 'region', featured: true, broker: 1, water: true, energy: true, sewer: true, created: 62 },
  { uf: 'GO', city: 'Aparecida de Goiânia', region: 'Região Metropolitana de Goiânia', neighborhood: 'Polo Empresarial', lat: -16.8360, lng: -49.2640, area: 92000, type: 'area_industrial', title: 'Área logística próxima à BR-153', img: 'fields',
    viab: ['logistico', 'industrial'], stage: 'sem_estudo', zone: 'Zona Industrial', ca: 1, price: 13_800_000, mods: ['venda', 'bts'], swap: null, units: null, vgv: null, status: 'em_negociacao', pub: 'published', precision: 'approximate', featured: false, broker: 0, water: true, energy: true, sewer: false, created: 55 },
  { uf: 'GO', city: 'Senador Canedo', region: 'Região Metropolitana de Goiânia', neighborhood: 'Jardim das Oliveiras', lat: -16.7080, lng: -49.0910, area: 420000, type: 'loteamento', title: 'Gleba para loteamento aberto em Senador Canedo', img: 'fields',
    viab: ['loteamento', 'habitacao_popular'], stage: 'em_aprovacao', zone: 'Macrozona de Expansão', ca: 1, price: null, mods: ['permuta_fisica', 'parceria'], swap: 45, units: 980, vgv: 156_000_000, status: 'disponivel', pub: 'published', precision: 'approximate', featured: true, broker: 0, water: true, energy: true, sewer: false, created: 48 },
  { uf: 'GO', city: 'Trindade', region: 'Região Oeste', neighborhood: 'Vila Pai Eterno', lat: -16.6550, lng: -49.4950, area: 265000, type: 'gleba', title: 'Gleba urbana com acesso pela GO-060', img: 'green',
    viab: ['loteamento', 'condominio_horizontal'], stage: 'sem_estudo', zone: 'Zona Urbana', ca: 1.2, price: 9_900_000, mods: ['venda', 'permuta_fisica'], swap: 40, units: null, vgv: null, status: 'disponivel', pub: 'published', precision: 'approximate', featured: false, broker: 2, water: true, energy: true, sewer: null, created: 40 },
  { uf: 'GO', city: 'Anápolis', region: 'Eixo Goiânia–Brasília', neighborhood: 'DAIA', lat: -16.3920, lng: -48.9600, area: 150000, type: 'area_industrial', title: 'Área industrial no eixo Goiânia–Brasília', img: 'fields',
    viab: ['industrial', 'logistico'], stage: 'diretrizes_emitidas', zone: 'Distrito Agroindustrial', ca: 1, price: 16_200_000, mods: ['venda', 'bts'], swap: null, units: null, vgv: null, status: 'disponivel', pub: 'published', precision: 'exact', featured: false, broker: 1, water: true, energy: true, sewer: true, created: 33 },
  { uf: 'DF', city: 'Brasília', region: 'Região Administrativa do Gama', neighborhood: 'Setor Leste', lat: -16.0200, lng: -48.0500, area: 54000, type: 'incorporacao_vertical', title: 'Terreno para incorporação vertical no Gama', img: 'urban',
    viab: ['verticalizacao', 'habitacao_popular'], stage: 'aprovado', zone: 'UOS — Uso Misto', ca: 3, price: 21_000_000, mods: ['permuta_financeira', 'venda'], swap: 20, units: 512, vgv: 205_000_000, status: 'disponivel', pub: 'published', precision: 'approximate', featured: true, broker: 2, water: true, energy: true, sewer: true, created: 28 },
  { uf: 'MG', city: 'Uberlândia', region: 'Setor Sul', neighborhood: 'Granja Marileusa', lat: -18.9580, lng: -48.2400, area: 310000, type: 'loteamento', title: 'Área para condomínio horizontal em Uberlândia', img: 'green',
    viab: ['condominio_horizontal', 'loteamento'], stage: 'estudo_preliminar', zone: 'ZUP — Zona Urbana de Planejamento', ca: 1, price: 27_500_000, mods: ['permuta_fisica', 'venda'], swap: 35, units: 410, vgv: 230_000_000, status: 'disponivel', pub: 'published', precision: 'approximate', featured: false, broker: 1, water: true, energy: true, sewer: true, created: 21 },
  { uf: 'TO', city: 'Palmas', region: 'Plano Diretor Sul', neighborhood: 'ARSE', lat: -10.2400, lng: -48.3300, area: 125000, type: 'gleba', title: 'Gleba na expansão sul de Palmas', img: 'fields',
    viab: ['loteamento', 'habitacao_popular'], stage: 'sem_estudo', zone: null, ca: null, price: 7_400_000, mods: ['venda'], swap: null, units: null, vgv: null, status: 'disponivel', pub: 'published', precision: 'region', featured: false, broker: 2, water: null, energy: true, sewer: null, created: 14, visibility: 'private' },
  { uf: 'GO', city: 'Rio Verde', region: 'Sudoeste Goiano', neighborhood: 'Saída para Jataí', lat: -17.7900, lng: -50.9300, area: 880000, type: 'area_rural', title: 'Área rural em transição para uso urbano', img: 'green',
    viab: ['loteamento'], stage: 'sem_estudo', zone: null, ca: null, price: 12_000_000, mods: ['venda', 'parceria'], swap: null, units: null, vgv: null, status: 'qualificada', pub: 'pending_review', precision: 'region', featured: false, broker: 0, water: null, energy: true, sewer: null, created: 9 },
  { uf: 'GO', city: 'Goiânia', region: 'Região Norte', neighborhood: 'Jardim Guanabara', lat: -16.6310, lng: -49.2410, area: 24000, type: 'area_comercial', title: 'Área comercial em corredor viário', img: 'urban',
    viab: ['comercial'], stage: 'sem_estudo', zone: 'Eixo de Desenvolvimento', ca: 3, price: 8_100_000, mods: ['venda', 'bts'], swap: null, units: null, vgv: null, status: 'analise', pub: 'draft', precision: 'approximate', featured: false, broker: 1, water: true, energy: true, sewer: true, created: 5 },
  { uf: 'GO', city: 'Hidrolândia', region: 'Região Sul', neighborhood: null, lat: -16.9600, lng: -49.2300, area: 640000, type: 'gleba', title: null, img: 'green',
    viab: [], stage: null, zone: null, ca: null, price: null, mods: [], swap: null, units: null, vgv: null, status: 'captacao', pub: 'draft', precision: 'approximate', featured: false, broker: null, water: null, energy: null, sewer: null, created: 2 },
] as const;

export async function seed() {
  await resetDatabase();

  // roles/permissions espelham a matriz do código (para consulta e relatórios)
  await db('roles').insert(Object.entries(ROLES).map(([key, name]) => ({ key, name })));
  for (const [role, res] of Object.entries(MATRIX)) {
    for (const [resource, g] of Object.entries(res)) await db('permissions').insert({ role_key: role, resource, actions: g!.actions, scope: g!.scope });
  }

  const [wings] = await db('organizations').insert({ name: 'WingsBr', slug: 'wingsbr', kind: 'platform' }).returning('*');
  const [dourado] = await db('organizations').insert({ name: 'Dourado Real Estate Partners', slug: 'dourado', kind: 'manager', code_prefix: 'DOU', central_whatsapp: '5562900000000' }).returning('*');
  const [horizonteOrg] = await db('organizations').insert({ name: 'Construtora Horizonte (fictícia)', slug: 'horizonte', kind: 'partner' }).returning('*');
  const [outra] = await db('organizations').insert({ name: 'Outra Gestora (fictícia — teste de isolamento)', slug: 'outra', kind: 'manager', code_prefix: 'OUT' }).returning('*');

  const mk = async (org: any, name: string, email: string, role: string, extra: any = {}) =>
    (await db('users').insert({ org_id: org.id, external_id: `wb_${crypto.randomUUID().slice(0, 8)}`, name, email, role, mfa_enabled: ['platform_admin', 'dourado_admin', 'capture_manager'].includes(role), ...extra }).returning('*'))[0];

  await mk(wings, 'Ana Ribeiro', 'ana@wingsbr.example', 'platform_admin');
  const admin = await mk(dourado, 'Marina Albuquerque', 'marina@dourado.example', 'dourado_admin');
  const captacao = await mk(dourado, 'Carlos Menezes', 'carlos@dourado.example', 'capture_manager');
  const bUsers = [
    await mk(dourado, 'Juliana Prado', 'juliana@parceiros.example', 'broker', { phone: '62999110001' }),
    await mk(dourado, 'Felipe Rocha', 'felipe@parceiros.example', 'broker', { phone: '62999110002' }),
    await mk(dourado, 'Beatriz Lemos', 'beatriz@parceiros.example', 'broker', { phone: '61999110003' }),
  ];
  const brokers: any[] = [];
  for (const [i, u] of bUsers.entries()) {
    const [b] = await db('land_brokers').insert({
      org_id: dourado.id, user_id: u.id, creci: `${10000 + i * 731}`, creci_uf: i === 2 ? 'DF' : 'GO', creci_status: 'ativo', creci_checked_at: daysAgo(20), whatsapp: u.phone,
    }).returning('*');
    brokers.push({ ...b, name: u.name });
  }
  const ownerUser = await mk(dourado, 'Antônio Ferreira', 'antonio.proprietario@example.com', 'owner');
  const buyer = await mk(horizonteOrg, 'Lucas Teixeira', 'lucas@horizonte.example', 'buyer');
  await mk(outra, 'Paulo Outra', 'paulo@outra.example', 'dourado_admin');

  // empresas e perfis de aquisição
  const [horizonte] = await db('partner_companies').insert({ org_id: dourado.id, partner_org_id: horizonteOrg.id, name: 'Construtora Horizonte (fictícia)', kind: 'construtora', contact_name: 'Lucas Teixeira', contact_email: 'lucas@horizonte.example' }).returning('*');
  const [vale] = await db('partner_companies').insert({ org_id: dourado.id, name: 'Incorporadora Vale Azul (fictícia)', kind: 'incorporadora', contact_name: 'Renata Dias', contact_email: 'renata@valeazul.example' }).returning('*');
  const [logi] = await db('partner_companies').insert({ org_id: dourado.id, name: 'Galpões Cerrado Log (fictícia)', kind: 'investidor', contact_name: 'Marcos Vidal' }).returning('*');
  await db('partner_companies').insert({ org_id: dourado.id, name: 'Loteadora Planalto (fictícia)', kind: 'loteadora', contact_name: 'Sônia Prates' });

  await db('acquisition_profiles').insert([
    { org_id: dourado.id, partner_company_id: horizonte.id, name: 'Verticais na Grande Goiânia', ufs: ['GO'], cities: ['Goiânia', 'Goianira', 'Aparecida de Goiânia'], min_area_m2: 15000, max_area_m2: 200000, typologies: ['verticalizacao', 'uso_misto'], budget_max: 25_000_000, modalities: ['permuta_fisica', 'permuta_financeira', 'venda'], max_swap_pct: 25, min_approval_stage: 'estudo_preliminar', restrictions: JSON.stringify({ require_water: true }), briefing: 'Torres residenciais médio padrão, 300 a 700 unidades.' },
    { org_id: dourado.id, partner_company_id: vale.id, name: 'Condomínios horizontais Centro-Oeste', ufs: ['GO', 'DF', 'MG'], cities: [], min_area_m2: 200000, max_area_m2: 600000, typologies: ['condominio_horizontal', 'loteamento'], budget_max: 30_000_000, modalities: ['permuta_fisica', 'parceria'], max_swap_pct: 40, min_approval_stage: null, restrictions: JSON.stringify({ urban_only: true }) },
    { org_id: dourado.id, partner_company_id: logi.id, name: 'Galpões BTS próximos a rodovias', ufs: ['GO'], cities: ['Aparecida de Goiânia', 'Anápolis'], min_area_m2: 50000, max_area_m2: 250000, typologies: ['logistico', 'industrial'], budget_max: 18_000_000, modalities: ['venda', 'bts'], restrictions: JSON.stringify({ require_energy: true }) },
  ]);

  // regras de roteamento
  await db('whatsapp_routing_rules').insert([
    { org_id: dourado.id, name: 'Goiás → intermediador da área', priority: 10, criteria: JSON.stringify({ ufs: ['GO'] }), target: 'assigned_broker', sla_minutes: 30 },
    { org_id: dourado.id, name: 'DF e TO → rodízio', priority: 20, criteria: JSON.stringify({ ufs: ['DF', 'TO'] }), target: 'round_robin', broker_ids: [brokers[1].id, brokers[2].id], sla_minutes: 60 },
    { org_id: dourado.id, name: 'Demais → central Dourado', priority: 90, criteria: '{}', target: 'central', sla_minutes: 120 },
  ]);

  // oportunidades
  const seq: Record<string, number> = {};
  const opps: any[] = [];
  for (const [i, a] of AREAS.entries()) {
    seq[a.uf] = (seq[a.uf] ?? 0) + 1;
    const code = `DOU-${a.uf}-${String(seq[a.uf]).padStart(4, '0')}`;
    const internal = `${a.city} — ${a.neighborhood ?? 'gleba'} (${Math.round(a.area / 10000)} ha)`;
    const [o] = await db('land_opportunities').insert({
      org_id: dourado.id, code, slug: buildSlug({ code, public_title: a.title, type: a.type, city: a.city }), internal_name: internal, public_title: a.title,
      type: a.type, city: a.city, uf: a.uf, neighborhood: a.neighborhood, region: a.region, address: a.neighborhood ? `${a.neighborhood}, ${a.city}/${a.uf} (endereço fictício)` : null,
      area_m2: a.area, usable_area_m2: Math.round(a.area * 0.72), frontage_m: Math.round(Math.sqrt(a.area / 1.4) * 1.4), depth_m: Math.round(Math.sqrt(a.area / 1.4)),
      topography: i % 3 === 0 ? 'Plana' : i % 3 === 1 ? 'Levemente ondulada' : 'Plana com declive suave',
      status: a.status, publication_status: a.pub, visibility: (a as any).visibility ?? 'public', featured: a.featured,
      summary: a.title ? `${a.title}. Oportunidade selecionada pela Dourado com documentação em análise.` : null,
      strategic_description: a.title ? `Área localizada em ${a.region}, com acesso consolidado e entorno em desenvolvimento. As informações técnicas indicadas possuem fonte e status de validação identificados — parâmetros não verificados não constituem aprovação oficial.` : null,
      internal_owner_id: captacao.id, created_by: captacao.id, draft_step: a.pub === 'draft' ? 2 : 7,
      published_at: a.pub === 'published' ? daysAgo(a.created - 3) : null, created_at: daysAgo(a.created), updated_at: daysAgo(i === 4 ? 45 : Math.max(1, a.created - 5)),
    }).returning('*');
    await db.transaction((trx) => saveGeometry(trx, o.id, polygon(a.lat, a.lng, a.area, 1.3 + (i % 3) * 0.25, i + 1), 'kml', captacao.id));
    await db('land_opportunities').where({ id: o.id }).update({ area_m2: a.area, updated_at: daysAgo(i === 4 ? 45 : Math.max(1, a.created - 5)) });
    await db('land_commercial_terms').insert({
      opportunity_id: o.id, modalities: a.mods, asking_price: a.price, swap_pct: a.swap, expected_units: a.units, vgv_preliminary: a.vgv,
      payment_terms: a.price ? '30% de entrada e saldo em até 24 meses (condição indicativa).' : 'Permuta com unidades ou percentual do VGV.',
      commission_total_pct: 6, commission_split: JSON.stringify([{ party: 'Dourado', pct: 3 }, { party: 'Intermediador responsável', pct: 3 }]),
      exclusivity: i < 4, exclusivity_until: i < 4 ? new Date(Date.now() + 120 * 86400_000).toISOString().slice(0, 10) : null, negotiable: true,
      internal_notes: 'Proprietário aberto a permuta parcial. (nota fictícia)',
    });
    await db('publication_permissions').insert({
      opportunity_id: o.id, show_price: !!a.price && i % 4 !== 1, show_price_per_m2: !!a.price && i % 4 !== 1, location_precision: a.precision,
      legal_basis: a.pub !== 'draft' ? null : null, submitted_by: a.pub !== 'draft' ? captacao.id : null, submitted_at: a.pub !== 'draft' ? daysAgo(a.created - 2) : null,
      reviewed_by: a.pub === 'published' ? admin.id : null, reviewed_at: a.pub === 'published' ? daysAgo(a.created - 3) : null,
    });
    const tech: Record<string, any> = {
      situacao: a.type === 'area_rural' ? 'expansao_urbana' : 'urbana', perimetro_urbano: a.type !== 'area_rural',
      zoneamento: a.zone, coef_aproveitamento: a.ca, taxa_ocupacao: a.ca ? 60 : null, agua: a.water, energia: a.energy, esgoto: a.sewer,
      acesso_rodovias: i % 2 ? 'Acesso asfaltado a 2 km de rodovia estadual' : 'Frente para via arterial pavimentada',
      estagio_aprovacao: a.stage, viabilidade: a.viab.length ? a.viab : null, app: i === 3 ? 'Faixa de APP ao longo de córrego (cerca de 8% da área)' : 'Não identificada no levantamento preliminar',
    };
    for (const [key, value] of Object.entries(tech)) {
      if (value == null) continue;
      const official = ['zoneamento', 'estagio_aprovacao'].includes(key) && i % 2 === 0;
      await db('land_technical_attributes').insert({
        opportunity_id: o.id, key, value: JSON.stringify(value),
        source: official ? 'Certidão de uso do solo da prefeitura (fictícia)' : key === 'viabilidade' ? 'Estudo de massa preliminar Dourado' : 'Declaração do proprietário',
        consulted_at: daysAgo(a.created).toISOString().slice(0, 10), responsible: 'Carlos Menezes',
        validation_status: official ? 'oficial' : key === 'viabilidade' ? 'verificado' : i % 3 === 0 ? 'verificado' : 'declarado',
      });
    }
    // mídia (ilustrações geradas)
    for (let k = 0; k < (a.pub === 'draft' && i === 11 ? 0 : 3); k++) {
      const key = await aerialImage(i * 10 + k, k === 0 ? a.img : (['fields', 'green', 'urban'] as const)[(i + k) % 3]);
      await db('land_media').insert({ opportunity_id: o.id, storage_key: key, caption: ['Vista aérea (ilustrativa)', 'Entorno (ilustrativo)', 'Acesso (ilustrativo)'][k], sort: k, is_cover: k === 0, width: 1400, height: 900 });
    }
    // documentos
    const docs: [string, string, string, number | null][] = [['matricula', 'Matrícula atualizada', 'confidential', 25], ['planta', 'Levantamento planialtimétrico', 'internal', null]];
    if (a.pub !== 'draft' || i === 10) docs.push(['authorization', 'Autorização de divulgação assinada', 'confidential', null]);
    if (a.pub === 'published') docs.push(['estudo_urbanistico', 'Resumo do estudo de massa', 'public', null]);
    if (i === 2) docs.push(['contrato_intermediacao', 'Contrato de intermediação', 'confidential', null]);
    for (const [cat, title, conf, validDays] of docs) {
      if (i === 11 && cat !== 'matricula') continue;
      const buf = tinyPdf(`${title} ${code}`);
      const key = newKey('docs', 'pdf');
      await storage.put(key, buf);
      await db('land_documents').insert({
        opportunity_id: o.id, group_id: crypto.randomUUID(), version: 1, category: cat, title, confidentiality: conf, storage_key: key, mime: 'application/pdf',
        original_name: `${cat}-${code}.pdf`, size: buf.length, sha256: sha256(buf), valid_until: validDays ? new Date(Date.now() + (i === 0 ? 18 : validDays * 10) * 86400_000).toISOString().slice(0, 10) : null, uploaded_by: captacao.id,
      });
    }
    await db('land_owners').insert({
      opportunity_id: o.id, user_id: i === 0 || i === 3 ? ownerUser.id : null, kind: i % 3 === 0 ? 'pj' : 'pf',
      name: i % 3 === 0 ? `Agropecuária Fictícia ${i + 1} Ltda.` : `Proprietário Fictício ${i + 1}`, document_enc: encrypt(i % 3 === 0 ? '00.000.000/0001-00' : '000.000.000-00'),
      email: `proprietario${i + 1}@example.com`, phone: `6299900${String(i).padStart(4, '0')}`, share_pct: 100,
    });
    if (a.broker != null) await db('broker_assignments').insert({ opportunity_id: o.id, broker_id: brokers[a.broker].id, role: 'primary', assigned_by: admin.id, created_at: daysAgo(a.created) });
    opps.push({ ...o, cfg: a });
  }
  // histórico de substituição de intermediador (área 3)
  await db('broker_assignments').insert({ opportunity_id: opps[2].id, broker_id: brokers[1].id, role: 'primary', active: false, assigned_by: admin.id, reason: 'Substituído por férias', ended_at: daysAgo(30), created_at: daysAgo(55) });

  // interesses ao longo de 12 semanas
  const channels = ['google_ads', 'meta_ads', 'organic', 'direct', 'referral', 'email'];
  const names = ['Renato Moura', 'Camila Duarte', 'Eduardo Pacheco', 'Fernanda Alves', 'Gustavo Lins', 'Helena Costa', 'Igor Martins', 'Larissa Fontes', 'Mateus Barros', 'Patrícia Nogueira', 'Rodrigo Sales', 'Tatiane Gomes'];
  const published = opps.filter((o) => o.cfg.pub === 'published');
  let n = 0;
  for (let d = 80; d >= 1; d -= 2) {
    const count = 1 + ((d * 7) % 4);
    for (let k = 0; k < count; k++) {
      n++;
      const o = published[(d + k * 3) % published.length];
      const identified = n % 3 !== 0;
      const b = o.cfg.broker != null ? brokers[o.cfg.broker] : null;
      const status = !identified ? (n % 5 === 0 ? 'message_received' : 'clicked') : n % 4 === 0 ? 'qualified' : n % 2 ? 'form_submitted' : 'message_received';
      const created = new Date(daysAgo(d).getTime() + k * 3600_000);
      const [i] = await db('opportunity_interests').insert({
        org_id: dourado.id, opportunity_id: o.id, intent_token: `DL-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, status, kind: n % 3 === 1 ? 'form' : 'whatsapp',
        channel: channels[n % channels.length], attribution: JSON.stringify({ utm_source: channels[n % channels.length].split('_')[0], utm_campaign: n % 2 ? 'areas-go-2026' : 'institucional' }),
        name: identified ? names[n % names.length] : null, email: identified ? `contato${n}@example.com` : null, phone: identified ? `55629988${String(n).padStart(5, '0')}` : null,
        company: identified && n % 2 ? ['Construtora Exemplo', 'Incorporadora Modelo', 'Grupo Ilustrativo'][n % 3] : null,
        consent: identified, legal_basis: identified ? 'consentimento' : null, broker_id: b?.id ?? null, routed_to_number: b?.whatsapp ? `55${b.whatsapp}` : '5562900000000',
        routed_via: b ? 'regra: Goiás → intermediador da área' : 'fallback: número central', sla_due_at: new Date(created.getTime() + 30 * 60000),
        first_response_at: identified && d > 3 ? new Date(created.getTime() + (n % 5) * 15 * 60000) : null,
        crm_contact_id: identified ? `emb_seed_${n}` : null, crm_sync_status: identified ? 'synced' : 'not_applicable', created_at: created, updated_at: created,
      }).returning('*');
      await db('interest_events').insert({ interest_id: i.id, type: i.kind === 'form' ? 'form' : 'click', created_at: created, payload: '{}' });
      if (identified) {
        await db('crm_contacts').insert({ id: `emb_seed_${n}`, org_id: dourado.id, name: i.name, email: i.email, phone: i.phone, company: i.company, tags: JSON.stringify(['dourado-land', `area:${o.code}`]) });
      }
    }
  }

  // negociações em várias etapas
  const negSpecs = [
    { o: 2, stage: 'due_diligence', partner: logi, value: 13_200_000, model: 'Venda à vista + BTS', d: 50 },
    { o: 0, stage: 'proposta', partner: horizonte, value: 17_000_000, model: 'Permuta física 22%', d: 35 },
    { o: 0, stage: 'apresentacao', partner: vale, value: null, model: null, d: 12 },
    { o: 3, stage: 'analise_viabilidade', partner: vale, value: null, model: 'Parceria 45%', d: 20 },
    { o: 6, stage: 'negociacao', partner: horizonte, value: 19_800_000, model: 'Permuta financeira 20%', d: 18 },
    { o: 1, stage: 'interesse_recebido', partner: null, value: null, model: null, d: 3 },
    { o: 5, stage: 'contrato', partner: logi, value: 15_900_000, model: 'Venda', d: 60 },
    { o: 7, stage: 'conclusao', partner: vale, value: 26_000_000, model: 'Permuta física 35%', d: 75, won: true },
  ];
  for (const s of negSpecs) {
    const o = opps[s.o];
    const b = o.cfg.broker != null ? brokers[o.cfg.broker] : brokers[0];
    const [neg] = await db('negotiations').insert({
      org_id: dourado.id, opportunity_id: o.id, partner_company_id: s.partner?.id ?? null, contact_name: s.partner?.contact_name ?? 'Eduardo Pacheco',
      contact_email: s.partner?.contact_email ?? 'contato3@example.com', stage: s.stage, status: s.won ? 'won' : 'open', owner_id: b.user_id,
      proposed_value: s.value, proposed_model: s.model, next_activity: s.won ? null : ['Enviar book atualizado', 'Visita técnica à área', 'Reunião de viabilidade', 'Retorno sobre contraproposta'][s.o % 4],
      next_activity_at: s.won ? null : new Date(Date.now() + ((s.o % 5) - 1) * 86400_000), expected_close: new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10),
      crm_contact_id: `emb_seed_neg_${s.o}`, created_at: daysAgo(s.d), updated_at: daysAgo(Math.max(1, s.d - 20)),
    }).returning('*');
    await db('negotiation_participants').insert({ negotiation_id: neg.id, broker_id: b.id });
    const acts = [['system', 'Negociação criada', s.d], ['call', 'Ligação de qualificação', s.d - 1], ['meeting', 'Apresentação da oportunidade', s.d - 4], ['visit', 'Visita técnica à área', s.d - 9]] as const;
    for (const [type, subject, ago] of acts) if (ago > 0) await db('activities').insert({ org_id: dourado.id, opportunity_id: o.id, negotiation_id: neg.id, type, subject, user_id: b.user_id, done_at: daysAgo(ago), created_at: daysAgo(ago) });
    if (s.value) {
      const [p] = await db('proposals').insert({ org_id: dourado.id, negotiation_id: neg.id, opportunity_id: o.id, current_version: s.stage === 'proposta' ? 1 : 2, status: s.won ? 'accepted' : s.stage === 'proposta' ? 'submitted' : 'countered', created_by: b.user_id, created_at: daysAgo(s.d - 10) }).returning('*');
      await db('proposal_versions').insert({ proposal_id: p.id, version: 1, side: 'comprador', acquisition_value: s.value * 0.92, swap_pct: s.model?.includes('ermuta') ? 18 : null, payment_schedule: JSON.stringify([{ label: 'Sinal', amount: s.value * 0.1, due: 'Na assinatura' }, { label: 'Saldo', amount: s.value * 0.82, due: '12 meses' }]), suspensive_conditions: 'Aprovação do projeto e certidões negativas.', analysis_days: 30, valid_until: new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10), broker_ids: [b.id], created_by: b.user_id, created_at: daysAgo(s.d - 10) });
      if (s.stage !== 'proposta') await db('proposal_versions').insert({ proposal_id: p.id, version: 2, side: 'vendedor', acquisition_value: s.value, swap_pct: s.model?.includes('ermuta') ? 22 : null, payment_schedule: JSON.stringify([{ label: 'Sinal', amount: s.value * 0.15, due: 'Na assinatura' }, { label: 'Saldo', amount: s.value * 0.85, due: '10 meses' }]), suspensive_conditions: 'Aprovação do projeto.', analysis_days: 20, broker_ids: [b.id], created_by: admin.id, created_at: daysAgo(s.d - 14) });
    }
    if (s.value && ['contrato', 'conclusao', 'due_diligence'].includes(s.stage)) {
      const statusC = s.won ? 'paga' : s.stage === 'contrato' ? 'exigivel' : 'prevista';
      await db('commissions').insert([
        { org_id: dourado.id, negotiation_id: neg.id, opportunity_id: o.id, broker_id: b.id, beneficiary_name: b.name, pct: 3, amount: s.value * 0.03, status: statusC, trigger_condition: 'Assinatura da escritura', paid_at: s.won ? daysAgo(10).toISOString().slice(0, 10) : null, history: JSON.stringify([{ to: statusC, at: daysAgo(s.d).toISOString(), by: 'seed' }]) },
        { org_id: dourado.id, negotiation_id: neg.id, opportunity_id: o.id, broker_id: null, beneficiary_name: 'Dourado Real Estate Partners', pct: 3, amount: s.value * 0.03, status: statusC, trigger_condition: 'Assinatura da escritura', paid_at: s.won ? daysAgo(10).toISOString().slice(0, 10) : null, history: '[]' },
      ]);
    }
  }

  // mensagem de WhatsApp sem token (para vínculo manual)
  await db('whatsapp_inbound').insert({ org_id: dourado.id, wa_message_id: 'wamid.seed.unlinked.1', from_hash: sha256('5562999887766'), from_masked: '*********7766', to_number: '5562900000000', text: 'Boa tarde, vi o anúncio da área em Goianira, ainda está disponível?', link_status: 'unlinked', received_at: daysAgo(1) });

  // área de OUTRA organização (testes de isolamento)
  const [foreign] = await db('land_opportunities').insert({ org_id: outra.id, code: 'OUT-SP-0001', slug: 'out-sp-0001-area-outra-gestora', internal_name: 'Área de outra gestora', public_title: 'Área de outra gestora', type: 'gleba', city: 'Campinas', uf: 'SP', area_m2: 50000, status: 'disponivel', publication_status: 'draft' }).returning('*');
  await db('land_commercial_terms').insert({ opportunity_id: foreign.id });
  await db('publication_permissions').insert({ opportunity_id: foreign.id });

  // captação: prospecções fictícias em várias etapas, sobre parcelas de demonstração
  const { createProspect, defaultChecklist } = await import('../routes/prospects.js');
  const PROS = [
    { title: 'Gleba às margens da GO-070', lat: -16.512, lng: -49.548, stage: 'analise', source: 'mapa_territorial', uses: ['loteamento', 'condominio_horizontal'], owner: 'Herdeiros Fictícios Silva', phone: '62999001122', docs: 5, priority: 'alta', city: 'Inhumas', type: 'gleba' },
    { title: 'Fazenda próxima ao anel viário', lat: -16.598, lng: -49.168, stage: 'documentacao', source: 'mapa_territorial', uses: ['logistico', 'industrial'], owner: 'Agro Fictícia Cerrado Ltda.', phone: '62999003344', docs: 2, priority: 'alta', city: 'Goiânia', type: 'area_rural' },
    { title: 'Área oferecida pelo site — Bela Vista', lat: -16.968, lng: -48.951, stage: 'contato', source: 'site_proprietario', uses: [], owner: 'José Fictício Ramos', phone: '62999005566', docs: 0, priority: 'media', city: 'Bela Vista de Goiás', type: 'gleba' },
    { title: 'Indicação: terreno no eixo Anápolis', lat: -16.272, lng: -48.995, stage: 'identificada', source: 'indicacao_parceiro', uses: ['industrial'], owner: null, phone: null, docs: 0, priority: 'media', city: 'Anápolis', type: 'area_industrial', broker: 1 },
    { title: 'Gleba para habitação em Trindade', lat: -16.672, lng: -49.452, stage: 'proposta_intermediacao', source: 'prospeccao_ativa', uses: ['habitacao_popular', 'loteamento'], owner: 'Maria Fictícia Andrade', phone: '62999007788', docs: 6, priority: 'alta', city: 'Trindade', type: 'loteamento' },
    { title: 'Área no Gama para verticalização', lat: -16.041, lng: -48.083, stage: 'identificada', source: 'mapa_territorial', uses: ['verticalizacao'], owner: null, phone: null, docs: 0, priority: 'baixa', city: 'Brasília', type: 'incorporacao_vertical' },
  ];
  for (const [i, x] of PROS.entries()) {
    const d = 0.02;
    const feats = demoTerritoryFeatures('sigef', [x.lng - d, x.lat - d, x.lng + d, x.lat + d]).features;
    const parcel = feats.find((f: any) => pointInGeometry([x.lng, x.lat], f.geometry)) ?? feats[0];
    const car = demoTerritoryFeatures('car', [x.lng - d, x.lat - d, x.lng + d, x.lat + d]).features.find((f: any) => pointInGeometry([x.lng, x.lat], f.geometry));
    const consulted = daysAgo(20 - i).toISOString();
    const p = await db.transaction((trx) => createProspect(trx, dourado.id, captacao.id, {
      title: x.title, source: x.source, land_type: x.type, uf: x.lat > -16.2 && x.lng > -48.3 ? 'DF' : 'GO', city: x.city, intended_uses: x.uses,
      owner_name: x.owner, owner_phone: x.phone, geojson: x.source === 'site_proprietario' ? undefined : parcel?.geometry, lat: x.lat, lng: x.lng,
      territory: [parcel && { layer: 'sigef', source: parcel.properties.fonte, consulted_at: consulted, properties: parcel.properties }, car && { layer: 'car', source: car.properties.fonte, consulted_at: consulted, properties: car.properties }].filter(Boolean),
      referred_by_broker_id: (x as any).broker != null ? brokers[(x as any).broker].id : null, legal_basis: x.source === 'site_proprietario' ? 'consentimento' : 'legitimo_interesse',
    }));
    const checklist = defaultChecklist().map((c, k) => ({ ...c, status: k < x.docs ? 'recebido' : k === x.docs ? 'solicitado' : 'pendente', updated_at: k <= x.docs ? daysAgo(5).toISOString() : null }));
    await db('land_prospects').where({ id: p.id }).update({ stage: x.stage, priority: x.priority, checklist: JSON.stringify(checklist), created_at: daysAgo(40 - i * 5), updated_at: daysAgo(10 - i) });
    if (x.stage !== 'identificada') await db('activities').insert({ org_id: dourado.id, prospect_id: p.id, type: 'call', subject: 'Conversa inicial com o proprietário', user_id: captacao.id, done_at: daysAgo(8 - i), created_at: daysAgo(8 - i) });
  }

  const { recomputeMatchesForOpportunity } = await import('../routes/matching.js');
  for (const o of opps) await recomputeMatchesForOpportunity(o.id);

  return { dourado, admin, captacao, brokers, ownerUser, buyer, opps, horizonte, foreign };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await seed();
  console.log(`Seed concluído: ${r.opps.length} áreas fictícias, ${r.brokers.length} intermediadores.`);
  await db.destroy();
}
