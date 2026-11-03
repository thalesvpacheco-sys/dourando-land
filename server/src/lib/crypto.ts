import crypto from 'node:crypto';
import { config } from '../config.js';

/** AES-256-GCM para dados pessoais sensíveis (CPF/CNPJ). Formato: iv.tag.cipher (base64url). */
export function encrypt(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.dataKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', config.dataKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/** Hash de IP com segredo (não reversível sem a chave; não guarda IP em claro). */
export const hashIp = (ip: string | undefined) => (ip ? crypto.createHmac('sha256', config.dataKey).update(ip).digest('hex') : null);

export function hmac(payload: string, secret: string | Buffer = config.dataKey) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function intentToken(): string {
  const bytes = crypto.randomBytes(6);
  return 'DL-' + Array.from(bytes, (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join('');
}

export function maskPhone(p: string) {
  const d = p.replace(/\D/g, '');
  return d.length > 4 ? `${'*'.repeat(d.length - 4)}${d.slice(-4)}` : '****';
}

export function normalizePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  let d = p.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 ? d : null;
}
