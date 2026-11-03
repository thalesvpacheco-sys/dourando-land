import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { config } from '../config.js';
import { badRequest } from './http.js';
import { hmac, safeEqual, sha256 } from './crypto.js';

/** Interface de armazenamento. Driver local em uso; driver S3 compatível é pendência de produção. */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export const storage: Storage = {
  async put(key, data) {
    const p = path.join(config.storageDir, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  },
  async get(key) {
    if (key.includes('..')) throw badRequest('Chave inválida');
    return fs.readFile(path.join(config.storageDir, key));
  },
};

const DOC_MIMES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'application/zip', // shp, kmz, docx/xlsx são zip
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-earth.kmz',
]);
const TEXT_EXT = new Set(['kml', 'geojson', 'json', 'txt', 'csv']);
const BLOCKED_EXT = new Set(['exe', 'js', 'html', 'htm', 'svg', 'bat', 'sh', 'php', 'msi', 'dll', 'jar']);

/**
 * Verifica a assinatura real do arquivo (magic bytes), não a extensão declarada.
 * Arquivos-texto (KML/GeoJSON) são aceitos só se forem UTF-8 válidos sem marcação HTML/script.
 */
export async function validateDocument(name: string, buf: Buffer): Promise<string> {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (BLOCKED_EXT.has(ext)) throw badRequest('Tipo de arquivo não permitido');
  const ft = await fileTypeFromBuffer(buf);
  if (ft) {
    if (!DOC_MIMES.has(ft.mime) && !(ft.mime === 'application/xml' && ext === 'kml')) throw badRequest(`Conteúdo do arquivo não permitido (${ft.mime})`);
    return ft.mime;
  }
  if (TEXT_EXT.has(ext)) {
    const s = buf.toString('utf8');
    if (s.includes('�')) throw badRequest('Arquivo de texto com codificação inválida');
    if (/<\s*(script|html|iframe)/i.test(s)) throw badRequest('Arquivo contém conteúdo ativo não permitido');
    return ext === 'kml' ? 'application/vnd.google-earth.kml+xml' : ext === 'csv' ? 'text/csv' : ext === 'txt' ? 'text/plain' : 'application/geo+json';
  }
  throw badRequest('Não foi possível identificar o tipo do arquivo');
}

/** Imagens: valida assinatura, remove metadados (EXIF/GPS) e converte para WebP. */
export async function processImage(buf: Buffer) {
  const ft = await fileTypeFromBuffer(buf);
  if (!ft || !['image/jpeg', 'image/png', 'image/webp'].includes(ft.mime)) throw badRequest('Envie imagens JPG, PNG ou WebP');
  const img = sharp(buf, { limitInputPixels: 80_000_000 }).rotate().resize({ width: 2400, withoutEnlargement: true });
  const out = await img.webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height };
}

export function newKey(prefix: string, ext: string) {
  const d = new Date();
  return `${prefix}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${ext}`;
}

// ---------------------------------------------------------------- URLs temporárias

const TTL_SECONDS = 600;

export function signDocumentUrl(docId: string, userId: string) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${docId}.${userId}.${exp}`;
  const token = Buffer.from(`${payload}.${hmac(payload)}`).toString('base64url');
  return { url: `/api/files/${token}`, expires_at: new Date(exp * 1000).toISOString() };
}

export function verifyDocumentToken(token: string): { docId: string; userId: string } | null {
  try {
    const [docId, userId, exp, sig] = Buffer.from(token, 'base64url').toString('utf8').split('.');
    if (!safeEqual(sig, hmac(`${docId}.${userId}.${exp}`))) return null;
    if (Number(exp) < Date.now() / 1000) return null;
    return { docId, userId };
  } catch {
    return null;
  }
}

export { sha256 };
