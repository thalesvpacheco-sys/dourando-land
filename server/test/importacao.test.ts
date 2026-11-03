/**
 * Importação do inventário (pastas do Drive). Textos fictícios que imitam os padrões reais do inventário:
 * anúncios em estilo WhatsApp, valores com notação solta, alqueires, perímetros desenhados como linha.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { brNumber, classifyFile, extractFromText, findCity, inferType, parseFolderName } from '../src/import/extract.js';
import { buildPlan } from '../src/import/plan.js';
import { applyPlan, measure } from '../src/import/apply.js';
import { FolderSource } from '../src/import/sources.js';
import { db } from '../src/db/knex.js';

describe('extração (puro)', () => {
  it('lê números em português, inclusive notação solta', () => {
    expect(brNumber('1.234.567,89')).toBe(1234567.89);
    expect(brNumber('38.900.000.00')).toBe(38900000);
    expect(brNumber('524.440,87')).toBe(524440.87);
    expect(brNumber('20')).toBe(20);
  });

  it('identifica município e UF pelo nome da pasta, preferindo o que vem primeiro', () => {
    expect(parseFolderName('ITAÍ - SÃO PAULO APROVADO')).toMatchObject({ city: 'Itaí', uf: 'SP', tags: ['aprovado'] });
    expect(parseFolderName('ÁREA OLARIA - CANOAS RS')).toMatchObject({ city: 'Canoas', uf: 'RS' });
    expect(parseFolderName('TRINDADE GO -  SOMENTE VENDA').tags).toContain('somente_venda');
    expect(parseFolderName('ANÁPOLIS - GO - 200 MIL METROS').statedArea?.value).toBe(200000);
    expect(findCity('Área em Aparecida de Goiânia - Faz. Exemplo')?.city).toBe('Aparecida de Goiânia');
  });

  it('separa valor total, VGV, valor por lote e aporte', () => {
    const t = `📍 Área fictícia – Projeto aprovado
 Área total de 524.440,87 m²
 Empreendimento com 850 lotes
 Valor de venda: R$ 45.000,00 por lote
 VGV estimado em R$ 38.250.000
VALOR 31 MILHÕES sendo aporte antecipado de 6 milhões no contrato. Aceita permuta física.`;
    const ex = extractFromText(t, 'teste.docx', 'SP');
    expect(ex.area?.value).toBeCloseTo(524440.87);
    expect(ex.lots?.value).toBe(850);
    expect(ex.price_per_lot?.value).toBe(45000);
    expect(ex.vgv?.value).toBe(38250000);
    expect(ex.asking_price?.value).toBe(31000000);
    expect(ex.down_payment?.value).toBe(6000000);
    expect(ex.modalities?.value).toEqual(expect.arrayContaining(['permuta_fisica', 'venda']));
    expect(ex.approval?.value).toBe('aprovado');
  });

  it('não confunde preço por m² com valor total, e o contexto não vaza entre valores', () => {
    const ex = extractFromText('Área de 70.000 m² Valor de venda: R$ 500,00/m² Valor total: R$ 35.000.000,00', 'a.docx', 'SP');
    expect(ex.asking_price?.value).toBe(35000000);
  });

  it('converte alqueires conforme a região e marca notação ambígua', () => {
    expect(extractFromText('Propriedade com 21 alqueires', 'a', 'GO').area?.value).toBe(21 * 48400);
    expect(extractFromText('Propriedade com 10 alqueires', 'a', 'SP').area?.value).toBe(10 * 24200);
    const ex = extractFromText('Valor atualizado pedido 9.800 milhões', 'a', 'GO');
    expect(ex.asking_price?.value).toBe(9800000);
    expect(ex.ambiguous_notation).toBe(true);
  });

  it('descarta valores implausíveis como valor total', () => {
    const ex = extractFromText('Área de 50.000 m². Valor do m²: R$ 4.000', 'a', 'RJ');
    expect(ex.asking_price).toBeNull();
    expect(extractFromText('VGV de R$ 38.900.000.000.000', 'a', 'SP').vgv).toBeNull();
  });

  it('"logística da região" não transforma loteamento em área logística', () => {
    const ex = extractFromText('Loteamento com 300 lotes, uma das melhores logísticas da região', 'a', 'RS');
    expect(inferType([], ex, 100000).value).toBe('loteamento');
    const ex2 = extractFromText('Área para condomínio logístico de galpões, BTS', 'a', 'SP');
    expect(inferType([], ex2, 100000).value).toBe('area_industrial');
  });

  it('classifica documentos pelo nome', () => {
    expect(classifyFile('X/MATRICULA 12.345 - EMITIDA.pdf').category).toBe('matricula');
    expect(classifyFile('X/Escritura 999.pdf').category).toBe('certidao');
    expect(classifyFile('X/Certificado Graprohab.pdf').category).toBe('projeto');
    expect(classifyFile('X/Projeto Urbanístico.pdf').category).toBe('estudo_urbanistico');
    expect(classifyFile('X/Documento sem título.docx').kind).toBe('description');
    expect(classifyFile('X/area.kmz').kind).toBe('geo');
  });
});

// ------------------------------------------------------------------ fluxo completo numa pasta fictícia

const KML = (coords: string, asLine = false) => `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>a</name>${
  asLine ? `<LineString><coordinates>${coords}</coordinates></LineString>` : `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
}</Placemark></Document></kml>`;
const SQ = (x: number, y: number, d = 0.005) => `${x},${y},0 ${x + d},${y},0 ${x + d},${y + d},0 ${x},${y + d},0 ${x},${y},0`;
async function docx(text: string) {
  const z = new JSZip();
  z.file('word/document.xml', `<w:document><w:body>${text.split('\n').map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

describe('importação idempotente (pasta fictícia)', () => {
  let root: string; let orgId: string; let userId: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'inv-'));
    const w = async (p: string, b: string | Buffer) => { await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true }); await fs.writeFile(path.join(root, p), b); };
    await w('ÁREA FICTÍCIA GOIANIRA (APROVADO)/area.kml', KML(SQ(-49.43, -16.49)));
    await w('ÁREA FICTÍCIA GOIANIRA (APROVADO)/Documento sem título.docx', await docx('Loteamento aprovado com 500 lotes\nValor de venda: R$ 12.000.000,00\nAceita permuta física'));
    await w('ÁREA FICTÍCIA GOIANIRA (APROVADO)/MATRICULA 1.234.pdf', Buffer.from('%PDF-1.4 fictício'));
    await w('ÁREA SEM TEXTO TRINDADE/linha.kml', KML(SQ(-49.5, -16.65), true)); // perímetro desenhado como linha
    await w('Parceiro Exemplo/Área Inhumas 1/a.kml', KML(SQ(-49.49, -16.36)));
    await w('Parceiro Exemplo/Área Inhumas 1/oferta.docx', await docx('Gleba de 30.000 m² para loteamento'));
    await w('Parceiro Exemplo/Área Nerópolis 2/b.kml', KML(SQ(-49.22, -16.4)));
    await w('Parceiro Exemplo/Área Nerópolis 2/oferta.docx', await docx('Área para condomínio horizontal'));
    const org = await db('organizations').where({ slug: 'dourado' }).first();
    orgId = org.id;
    userId = (await db('users').where({ org_id: orgId, role: 'dourado_admin' }).first()).id;
  });
  afterAll(async () => {
    const items = await db('import_items').where({ source: 'teste:inventario' });
    for (const it of items) {
      if (it.entity_type === 'opportunity') await db('land_opportunities').where({ id: it.entity_id }).del().catch(() => {});
    }
    await db('import_items').where({ source: 'teste:inventario' }).del();
    await db('import_runs').where({ source: 'teste:inventario' }).del();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('planeja: pasta agrupadora vira várias áreas; linha fechada vira perímetro; sem texto vai para captação', async () => {
    const plan = await buildPlan(new FolderSource(root));
    await measure(plan, db);
    expect(plan.units.map((u) => u.name).sort()).toEqual(['Área Inhumas 1', 'Área Nerópolis 2', 'ÁREA FICTÍCIA GOIANIRA (APROVADO)', 'ÁREA SEM TEXTO TRINDADE'].sort());
    const goianira = plan.units.find((u) => u.name.includes('GOIANIRA'))!;
    expect(goianira.destination).toBe('opportunity');
    expect(goianira.geometry.area_m2).toBeGreaterThan(250000);
    const trindade = plan.units.find((u) => u.name.includes('TRINDADE'))!;
    expect(trindade.geometry.lines_closed).toBe(1);
    expect(trindade.destination).toBe('prospect');
    expect(plan.units.find((u) => u.name === 'Área Inhumas 1')!.group).toBe('Parceiro Exemplo');
  });

  it('aplica sem publicar nada e reaplica sem duplicar, preservando edição da equipe', async () => {
    const src = new FolderSource(root);
    const run = async () => { const p = await buildPlan(src); await measure(p, db); return applyPlan(db, p, src, { orgId, userId, source: 'teste:inventario', mode: 'apply' }); };
    const r1 = await run();
    expect(r1.summary.created).toBe(4);
    const goi = r1.results.find((r) => r.name.includes('GOIANIRA'))!;
    const opp = await db('land_opportunities').where({ id: goi.entity_id }).first();
    expect(opp).toMatchObject({ status: 'captacao', publication_status: 'draft', visibility: 'private', city: 'Goianira', uf: 'GO' });
    const terms = await db('land_commercial_terms').where({ opportunity_id: opp.id }).first();
    expect(Number(terms.asking_price)).toBe(12000000);
    expect(terms.internal_notes).toContain('Origem: inventário');
    const docs = await db('land_documents').where({ opportunity_id: opp.id });
    expect(docs.map((d) => d.category).sort()).toEqual(['geo', 'matricula', 'outro']); // o texto de oferta original também fica guardado
    expect(docs.every((d) => d.confidentiality === 'confidential')).toBe(true);
    const tech = await db('land_technical_attributes').where({ opportunity_id: opp.id, key: 'estagio_aprovacao' }).first();
    expect(tech.validation_status).toBe('declarado');

    const r2 = await run();
    expect(r2.summary).toMatchObject({ created: 0, updated: 0, unchanged: 4 });

    // equipe corrige o preço; depois o texto muda no Drive → preço da equipe é mantido, conflito registrado
    await db('land_commercial_terms').where({ opportunity_id: opp.id }).update({ asking_price: 11500000 });
    await fs.writeFile(path.join(root, 'ÁREA FICTÍCIA GOIANIRA (APROVADO)/Documento sem título.docx'), await docx('Loteamento aprovado com 520 lotes\nValor de venda: R$ 13.000.000,00'));
    const r3 = await run();
    const g3 = r3.results.find((r) => r.name.includes('GOIANIRA'))!;
    expect(g3.action).toBe('updated');
    expect(g3.conflicts.join(' ')).toContain('asking_price');
    const t3 = await db('land_commercial_terms').where({ opportunity_id: opp.id }).first();
    expect(Number(t3.asking_price)).toBe(11500000);
    expect(Number(t3.expected_units)).toBe(520); // campo não editado pela equipe é atualizado
    expect(await db('land_opportunities').where({ org_id: orgId, internal_name: opp.internal_name }).count({ c: '*' }).first().then((r: any) => Number(r.c))).toBe(1);
  });
});
