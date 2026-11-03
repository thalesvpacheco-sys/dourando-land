/**
 * Monta o plano de importação a partir de uma origem: o que cada pasta vira (área do banco ou prospecção),
 * com quais campos, de onde veio cada um e o que precisa de revisão. Não grava nada.
 */
import crypto from 'node:crypto';
import { parseGeoFile, polygonsOf } from '../geo/geo.js';
import {
  classifyFile, driveFolderId, extractFromText, findCity, inferType, norm, parseFolderName, sheetKind,
  type Evidence, type Extracted, type FileEntry, type FolderInfo,
} from './extract.js';
import { officeText, readXlsx, type InventorySource } from './sources.js';
import type { DocCategory, LandType } from '@dl/shared';

export type PlannedFile = FileEntry & { kind: string; category: DocCategory | null; available: boolean };
export type Issue = { level: 'bloqueia' | 'revisar' | 'aviso'; code: string; message: string };
export type SheetMatch = { kind: string; file: string; sheet: string; row: number; data: Record<string, any> };

export type UnitPlan = {
  key: string; // caminho da pasta, estável entre execuções
  name: string;
  group: string | null; // pasta de parceiro que agrupa várias áreas
  content_hash: string;
  folder: FolderInfo;
  city: Evidence<string> | null;
  uf: Evidence<string> | null;
  type: Evidence<LandType>;
  extracted: Extracted | null;
  description_files: string[];
  description_text: string;
  geometry: { polygons: any[]; points: [number, number][]; lines_closed: number; lines_open: number; files: string[]; area_m2?: number; centroid?: [number, number] } ;
  area: Evidence<number> | null;
  files: PlannedFile[];
  sheets: SheetMatch[];
  destination: 'opportunity' | 'prospect';
  issues: Issue[];
};

export type Plan = {
  source: string;
  generated_at: string;
  units: UnitPlan[];
  notes: { path: string; text: string }[]; // documentos soltos (atas, resumos) — não viram área
  sheets: { file: string; sheet: string; kind: string; rows: number }[];
  unmatched: SheetMatch[]; // linhas de planilha sem pasta correspondente
  demands: SheetMatch[]; // pedidos de compradores (perfis de aquisição)
  ignored: { file: string; sheet: string; reason: string }[];
  totals: Record<string, number>;
};

const hashOf = (files: FileEntry[]) => crypto.createHash('sha256').update(files.map((f) => `${f.path}\0${f.sha256}`).sort().join('\n')).digest('hex');

/** Linhas fechadas desenhadas no Google Earth como "caminho" viram polígono (comum no inventário). */
function closeLines(geo: any) {
  const out = { polygons: [] as any[], closed: 0, open: 0, points: [] as [number, number][] };
  const visit = (g: any) => {
    if (!g) return;
    if (g.type === 'FeatureCollection') return g.features.forEach((f: any) => visit(f.geometry));
    if (g.type === 'Feature') return visit(g.geometry);
    if (g.type === 'GeometryCollection') return g.geometries.forEach(visit);
    if (g.type === 'Point') out.points.push([g.coordinates[0], g.coordinates[1]]);
    if (g.type === 'LineString' || g.type === 'MultiLineString') {
      for (const c of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
        if (c.length < 4) { out.open++; continue; }
        const [x0, y0] = c[0]; const [x1, y1] = c[c.length - 1];
        const xs = c.map((p: number[]) => p[0]); const ys = c.map((p: number[]) => p[1]);
        const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        if (diag > 0 && Math.hypot(x1 - x0, y1 - y0) <= diag * 0.05) {
          out.polygons.push({ type: 'Polygon', coordinates: [[...c.map((p: number[]) => [p[0], p[1]]), [c[0][0], c[0][1]]]] });
          out.closed++;
        } else out.open++;
      }
    }
  };
  visit(geo);
  return out;
}

export async function buildPlan(src: InventorySource): Promise<Plan> {
  const all = await src.list();
  const byTop = new Map<string, FileEntry[]>();
  const loose: FileEntry[] = [];
  for (const f of all) {
    const parts = f.path.split('/');
    if (parts.length === 1) loose.push(f);
    else (byTop.get(parts[0]) ?? byTop.set(parts[0], []).get(parts[0])!).push(f);
  }

  const plan: Plan = { source: src.label, generated_at: new Date().toISOString(), units: [], notes: [], sheets: [], unmatched: [], demands: [], ignored: [], totals: {} };
  const sheetRows: SheetMatch[] = [];

  const readText = async (p: string) => { const b = await src.read(p); return b ? officeText(p, b).catch(() => '') : ''; };
  for (const f of loose) if (classifyFile(f.path).kind === 'description') plan.notes.push({ path: f.path, text: (await readText(f.path)).slice(0, 4000) });

  // ---------------------------------------------------------------- unidades
  const unitsRaw: { key: string; name: string; group: string | null; files: FileEntry[] }[] = [];
  for (const [top, files] of byTop) {
    const kinds = files.map((f) => classifyFile(f.path).kind);
    const direct = files.filter((f) => f.path.split('/').length === 2);
    // pasta de controle: só planilhas e textos, sem geo/documento/imagem
    const isControl = kinds.includes('spreadsheet') && !kinds.some((k) => ['geo', 'image', 'video', 'cad'].includes(k)) && !files.some((f) => /\.pdf$/i.test(f.path));
    if (isControl) {
      for (const f of files) {
        const k = classifyFile(f.path).kind;
        if (k === 'spreadsheet') {
          const buf = await src.read(f.path);
          if (!buf || (buf as any).__textOnly) { plan.ignored.push({ file: f.path, sheet: '*', reason: 'planilha não disponível na origem' }); continue; }
          for (const sh of await readXlsx(buf)) {
            const hi = sh.rows.findIndex((r) => r.filter((c) => c != null && String(c).trim()).length >= 3);
            if (hi < 0) continue;
            const headers = sh.rows[hi].map((h) => String(h ?? '').trim());
            let kind = sheetKind(headers);
            if (kind === 'acompanhamento' && /SOLICITA/i.test(sh.name)) kind = 'solicitacoes';
            const data = sh.rows.slice(hi + 1).map((r, i) => ({ r, i: hi + i + 2 })).filter(({ r }) => r.some((c) => c != null && String(c).trim()));
            plan.sheets.push({ file: f.path, sheet: sh.name, kind: kind ?? 'desconhecida', rows: data.length });
            if (!kind || kind === 'vendas_residenciais') { plan.ignored.push({ file: f.path, sheet: sh.name, reason: kind ? 'vendas residenciais (fora do escopo de áreas)' : 'cabeçalho não reconhecido' }); continue; }
            for (const { r, i } of data) {
              const row: Record<string, any> = {};
              headers.forEach((h, j) => { if (h) row[h] = r[j]; });
              // colunas sem cabeçalho (semáforo e status) no fim da linha
              const extra = r.slice(headers.length).filter((c) => c != null && String(c).trim());
              if (extra.length) row['Situação (planilha)'] = extra.join(' ').trim();
              sheetRows.push({ kind, file: f.path, sheet: sh.name, row: i, data: row });
            }
          }
        } else if (k === 'description') plan.notes.push({ path: f.path, text: (await readText(f.path)).slice(0, 4000) });
      }
      continue;
    }
    const subdirs = [...new Set(files.filter((f) => f.path.split('/').length > 2).map((f) => f.path.split('/')[1]))];
    const subUnits = subdirs.filter((s) => files.some((f) => f.path.startsWith(`${top}/${s}/`) && ['geo', 'description'].includes(classifyFile(f.path).kind)));
    if (subUnits.length >= 2 && !direct.some((f) => classifyFile(f.path).kind === 'geo')) {
      for (const s of subUnits) unitsRaw.push({ key: `${top}/${s}`, name: s, group: top, files: files.filter((f) => f.path.startsWith(`${top}/${s}/`)) });
      const rest = files.filter((f) => !subUnits.some((s) => f.path.startsWith(`${top}/${s}/`)));
      for (const f of rest) if (classifyFile(f.path).kind === 'description') plan.notes.push({ path: f.path, text: (await readText(f.path)).slice(0, 4000) });
    } else unitsRaw.push({ key: top, name: top, group: null, files });
  }

  for (const u of unitsRaw) {
    const folder = parseFolderName(u.name);
    const files: PlannedFile[] = [];
    for (const f of u.files) {
      const c = classifyFile(f.path);
      files.push({ ...f, kind: c.kind, category: c.category, available: src.complete || !!(await src.read(f.path)) });
    }
    const descFiles = files.filter((f) => f.kind === 'description');
    const texts: string[] = [];
    for (const f of descFiles) { const t = await readText(f.path); if (t.trim()) texts.push(t); }
    const text = texts.join('\n\n');
    const issues: Issue[] = [];

    const cityHit = folder.city ? { value: folder.city, source: 'nome da pasta' } : (() => { const c = findCity(text.slice(0, 600)); return c ? { value: c.city, source: 'texto de oferta' } : null; })();
    const ufVal = folder.uf ?? (cityHit ? findCity(cityHit.value)?.uf ?? null : null);
    const uf = ufVal ? { value: ufVal, source: folder.uf ? 'nome da pasta' : 'município' } : null;
    const extracted = text.trim() ? extractFromText(text, descFiles.map((f) => f.path.split('/').pop()).join(', '), ufVal) : null;

    // geometria
    const geometry: UnitPlan['geometry'] = { polygons: [], points: [], lines_closed: 0, lines_open: 0, files: [] };
    for (const f of files.filter((x) => x.kind === 'geo')) {
      const buf = await src.read(f.path);
      if (!buf) { issues.push({ level: 'aviso', code: 'geo_indisponivel', message: `Arquivo geográfico não trazido: ${f.path}` }); continue; }
      try {
        const gj = await parseGeoFile(f.path, buf);
        const polys = polygonsOf(gj);
        const cl = closeLines(gj);
        geometry.polygons.push(...polys, ...cl.polygons);
        geometry.points.push(...cl.points);
        geometry.lines_closed += cl.closed; geometry.lines_open += cl.open;
        geometry.files.push(f.path);
      } catch (e: any) { issues.push({ level: 'revisar', code: 'geo_invalido', message: `Não foi possível ler ${f.path.split('/').pop()}: ${e.message}` }); }
    }
    if (geometry.lines_closed) issues.push({ level: 'aviso', code: 'linha_fechada', message: `${geometry.lines_closed} perímetro(s) desenhado(s) como linha no Earth foram fechados em polígono` });
    if (geometry.files.length > 1) issues.push({ level: 'revisar', code: 'varios_geo', message: `${geometry.files.length} arquivos geográficos na pasta: confirmar se são a mesma área ou áreas distintas` });

    const hasPerimeter = geometry.polygons.length > 0;
    const hasPoint = hasPerimeter || geometry.points.length > 0;
    const area: Evidence<number> | null = extracted?.area ?? folder.statedArea ?? null;

    if (!cityHit) issues.push({ level: 'bloqueia', code: 'sem_cidade', message: 'Município não identificado no nome da pasta nem no texto' });
    if (!uf) issues.push({ level: 'bloqueia', code: 'sem_uf', message: 'UF não identificada' });
    if (!hasPoint) issues.push({ level: 'bloqueia', code: 'sem_localizacao', message: 'Sem KML/KMZ com perímetro ou ponto' });
    else if (!hasPerimeter) issues.push({ level: 'revisar', code: 'sem_perimetro', message: 'KML só com ponto/linha aberta: localização aproximada, sem perímetro' });
    if (!text.trim()) issues.push({ level: 'bloqueia', code: 'sem_descricao', message: 'Sem texto de oferta (docx/pptx)' });
    if (extracted?.personal_data.length) issues.push({ level: 'revisar', code: 'dados_pessoais', message: `Texto contém ${extracted.personal_data.join(', ')}: fica só nas notas internas` });
    if (folder.tags.includes('aprovacao_a_renovar')) issues.push({ level: 'revisar', code: 'aprovacao_vencida', message: 'Pasta indica aprovação a renovar' });
    if ((folder.tags.includes('aprovado') || extracted?.approval) && !files.some((f) => ['projeto', 'estudo_ambiental', 'estudo_urbanistico'].includes(f.category ?? '')))
      issues.push({ level: 'revisar', code: 'aprovacao_sem_documento', message: 'Aprovação declarada sem projeto/licença na pasta' });
    if (!files.some((f) => f.category === 'matricula' || f.category === 'certidao') && !extracted?.matriculas.length)
      issues.push({ level: 'aviso', code: 'sem_matricula', message: 'Nenhuma matrícula/escritura identificada' });
    if (extracted && !extracted.asking_price && !extracted.price_per_lot && !extracted.price_per_m2 && !extracted.vgv)
      issues.push({ level: 'aviso', code: 'sem_valor', message: 'Sem valor identificado no texto' });
    if (extracted?.ambiguous_notation) issues.push({ level: 'revisar', code: 'valor_notacao', message: 'Valor escrito com notação ambígua (ex.: "9.800 milhões"): conferir' });
    if (extracted?.money_unclassified.length && !extracted.asking_price)
      issues.push({ level: 'revisar', code: 'valor_ambiguo', message: `Valores sem contexto claro: ${extracted.money_unclassified.slice(0, 3).map((m) => m.value.toLocaleString('pt-BR')).join(' · ')}` });

    plan.units.push({
      key: u.key, name: folder.name, group: u.group, content_hash: hashOf(u.files), folder, city: cityHit, uf, extracted,
      type: inferType(folder.tags, extracted, area?.value ?? null), description_files: descFiles.map((f) => f.path), description_text: text,
      geometry, area, files, sheets: [], issues,
      destination: issues.some((i) => i.level === 'bloqueia') ? 'prospect' : 'opportunity',
    });
  }

  // ---------------------------------------------------------------- planilhas → pastas
  const cityOfRow = (r: SheetMatch) => findCity(String(r.data['Localização'] ?? r.data['LOCALIZAÇÃO'] ?? r.data['Cidade'] ?? ''));
  for (const r of sheetRows) {
    if (r.kind === 'pedidos' || r.kind === 'solicitacoes') { plan.demands.push(r); continue; }
    const c = cityOfRow(r);
    const link = driveFolderId(Object.values(r.data).join(' '));
    if (link) r.data['__drive_folder_id'] = link;
    const cands = c ? plan.units.filter((u) => u.city?.value === c.city) : [];
    let best = cands[0];
    const rowArea = Number(r.data['Área (m²)']);
    if (cands.length > 1 && rowArea) best = cands.reduce((a, b) => (Math.abs((b.area?.value ?? 0) - rowArea) < Math.abs((a.area?.value ?? 0) - rowArea) ? b : a));
    if (best && (cands.length === 1 || rowArea)) {
      best.sheets.push(r);
      if (cands.length > 1) best.issues.push({ level: 'revisar', code: 'planilha_varias_pastas', message: `Linha ${r.row} de ${r.sheet} (${r.file.split('/').pop()}) casada por metragem entre ${cands.length} pastas de ${c!.city}` });
    } else plan.unmatched.push(r);
  }

  // ---------------------------------------------------------------- totais
  const t = plan.totals;
  t.pastas = plan.units.length; t.arquivos = all.length;
  t.areas_banco = plan.units.filter((u) => u.destination === 'opportunity').length;
  t.prospeccoes = plan.units.filter((u) => u.destination === 'prospect').length;
  t.com_perimetro = plan.units.filter((u) => u.geometry.polygons.length).length;
  t.so_ponto = plan.units.filter((u) => !u.geometry.polygons.length && u.geometry.points.length).length;
  t.documentos = plan.units.reduce((s, u) => s + u.files.filter((f) => ['document', 'cad', 'spreadsheet'].includes(f.kind)).length, 0);
  t.imagens = plan.units.reduce((s, u) => s + u.files.filter((f) => f.kind === 'image').length, 0);
  t.videos = plan.units.reduce((s, u) => s + u.files.filter((f) => f.kind === 'video').length, 0);
  t.linhas_planilha_casadas = plan.units.reduce((s, u) => s + u.sheets.length, 0);
  t.linhas_planilha_sem_pasta = plan.unmatched.length;
  t.pedidos_compradores = plan.demands.length;
  return plan;
}

export const normKey = (s: string) => norm(s).trim();
