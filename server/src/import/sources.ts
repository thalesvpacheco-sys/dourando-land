/**
 * Origem dos arquivos do inventário.
 *  - FolderSource: pasta local (cópia do Drive, Google Drive para desktop ou volume montado). Lê tudo.
 *  - PackageSource: manifest.json (caminho, tamanho, data, sha256 de todos os arquivos) + files/ com apenas
 *    os arquivos leves (descrições, KML/KMZ, planilhas). Serve para a prévia sem copiar 1,7 GB de PDFs e vídeos.
 *  - Google Drive API (conta de serviço) é o próximo driver: mesma interface, ver docs/IMPORTACAO-INVENTARIO.md.
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { norm, type FileEntry } from './extract.js';

export interface InventorySource {
  label: string;
  list(): Promise<FileEntry[]>;
  /** null quando o arquivo existe no manifesto mas não foi trazido (PackageSource). */
  read(rel: string): Promise<Buffer | null>;
  /** se a origem tem todos os bytes (documentos e imagens podem ser anexados). */
  complete: boolean;
}

const IGNORE = /(^|\/)(\.|~\$|_LEVANTAMENTO_|_IMPORTACAO_|Thumbs\.db|desktop\.ini)/i;

export class FolderSource implements InventorySource {
  complete = true;
  constructor(private root: string, public label = root) {}
  async list() {
    const out: FileEntry[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const rel = norm(path.relative(this.root, abs).split(path.sep).join('/'));
        if (IGNORE.test(rel)) continue;
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) {
          const st = await fs.stat(abs);
          const h = crypto.createHash('sha256');
          for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
          out.push({ path: rel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), sha256: h.digest('hex') });
        }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  private index: Map<string, string> | null = null;
  async read(rel: string) {
    // nomes vindos do macOS chegam em NFD: indexa uma vez pelo nome normalizado
    if (!this.index) {
      this.index = new Map();
      const walk = async (dir: string) => {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) await walk(abs);
          else this.index!.set(norm(path.relative(this.root, abs).split(path.sep).join('/')), abs);
        }
      };
      await walk(this.root);
    }
    const abs = this.index.get(rel);
    return abs ? fs.readFile(abs) : null;
  }
}

export class PackageSource implements InventorySource {
  complete = false;
  private files = new Map<string, string>();
  constructor(private dir: string, public label = dir) {}
  async list() {
    const man: FileEntry[] = JSON.parse(await fs.readFile(path.join(this.dir, 'manifest.json'), 'utf8'));
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) await walk(abs);
        else this.files.set(norm(path.relative(path.join(this.dir, 'files'), abs).split(path.sep).join('/')), abs);
      }
    };
    await walk(path.join(this.dir, 'files'));
    return man.map((m) => ({ ...m, path: norm(m.path) })).filter((m) => !IGNORE.test(m.path));
  }
  async read(rel: string) {
    // pptx/xlsx podem ter vindo convertidos em texto (<arquivo>.txt) para caber no pacote
    const abs = this.files.get(rel);
    if (abs) return fs.readFile(abs);
    const txt = this.files.get(`${rel}.txt`);
    return txt ? Object.assign(await fs.readFile(txt), { __textOnly: true }) : null;
  }
}

// ------------------------------------------------------------------ leitura de Office sem dependências extras

const xmlText = (x: string) => x.replace(/<w:tab\/>/g, '\t').replace(/<\/(w|a):p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

/** Texto de .docx, .pptx ou .txt. */
export async function officeText(name: string, buf: Buffer): Promise<string> {
  if ((buf as any).__textOnly || /\.txt$/i.test(name)) return buf.toString('utf8');
  const zip = await JSZip.loadAsync(buf);
  if (/\.docx$/i.test(name)) return xmlText((await zip.file('word/document.xml')?.async('string')) ?? '');
  if (/\.pptx$/i.test(name)) {
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    return (await Promise.all(slides.map(async (s) => xmlText(await zip.file(s)!.async('string'))))).join('\n');
  }
  return '';
}

/** Leitor mínimo de .xlsx: cada aba vira matriz de valores (strings, números). */
export async function readXlsx(buf: Buffer): Promise<{ name: string; rows: any[][] }[]> {
  const zip = await JSZip.loadAsync(buf);
  const shared: string[] = [];
  const ss = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (ss) for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(xmlText((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []).join('')));
  const wb = await zip.file('xl/workbook.xml')!.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const target = (rid: string) => rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`))?.[1];
  const sheets: { name: string; rows: any[][] }[] = [];
  for (const m of wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const t = target(m[2]); if (!t) continue;
    const xml = await zip.file(t.startsWith('/') ? t.slice(1) : `xl/${t}`)?.async('string'); if (!xml) continue;
    const rows: any[][] = [];
    for (const r of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const ri = Number(r.match(/<row[^>]* r="(\d+)"/)?.[1] ?? rows.length + 1) - 1;
      const row: any[] = [];
      for (const c of r.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = c.match(/ r="([A-Z]+)\d+"/)?.[1] ?? '';
        const col = [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const type = c.match(/ t="(\w+)"/)?.[1];
        const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = c.match(/<is>([\s\S]*?)<\/is>/)?.[1];
        row[col] = type === 's' ? shared[Number(v)] : type === 'inlineStr' ? xmlText(inline ?? '') : type === 'str' ? xmlText(v ?? '') : v != null ? Number(v) : null;
      }
      rows[ri] = row;
    }
    sheets.push({ name: xmlText(m[1]), rows: Array.from(rows, (r) => r ?? []) });
  }
  return sheets;
}
