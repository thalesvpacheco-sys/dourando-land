/** Senhas (scrypt) e verificação em duas etapas (TOTP, RFC 6238). Sem dependências além do Node. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const N = 2 ** 15, R = 8, P = 1, LEN = 32;
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password.normalize('NFKC'), salt, LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // Sem senha cadastrada, ainda calcula um hash: o tempo de resposta não revela se o e-mail existe.
  const parts = (stored ?? '').split('$');
  const valid = parts.length === 6 && parts[0] === 'scrypt';
  const salt = valid ? Buffer.from(parts[4], 'base64url') : Buffer.alloc(16);
  const opts = valid ? { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), maxmem: MAXMEM } : { N, r: R, p: P, maxmem: MAXMEM };
  const dk = await scrypt(password.normalize('NFKC'), salt, LEN, opts);
  return valid && crypto.timingSafeEqual(dk, Buffer.from(parts[5], 'base64url'));
}

const COMMON = ['password', 'senha', '12345678', '123456789', '1234567890', 'qwerty', 'dourado', 'admin', 'abcdefgh', '11111111'];

/** Política: mínimo de 10 caracteres, sem repetir o e-mail nem usar sequências comuns. Retorna o motivo da recusa. */
export function passwordProblem(password: string, email?: string | null): string | null {
  if (password.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (password.length > 200) return 'A senha pode ter no máximo 200 caracteres.';
  const low = password.toLowerCase();
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && low.includes(local)) return 'A senha não pode conter o seu e-mail.';
  if (new Set(low).size < 5) return 'Use uma senha menos repetitiva.';
  if (COMMON.some((c) => low.startsWith(c) && low.replace(c, '').length < 4)) return 'Essa senha é muito comum. Escolha outra.';
  return null;
}

// ------------------------------------------------------------------ TOTP

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret(): string {
  let out = '';
  for (const b of crypto.randomBytes(20)) out += B32[b % 32];
  return out;
}
function base32Decode(s: string): Buffer {
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpAt(secret: string, step: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export const currentStep = (now = Date.now()) => Math.floor(now / 30000);

/** Aceita a janela atual e ±1 (relógio do celular) e nunca um passo já usado. Retorna o passo aceito. */
export function verifyTotp(secret: string, code: string, lastStep: number, now = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const s = currentStep(now);
  for (const step of [s - 1, s, s + 1]) {
    if (step <= lastStep) continue;
    const a = Buffer.from(totpAt(secret, step)), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return step;
  }
  return null;
}
export const otpauthUrl = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(`Dourado Land:${email}`)}?secret=${secret}&issuer=${encodeURIComponent('Dourado Land')}&algorithm=SHA1&digits=6&period=30`;

export function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const s = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
export const hashRecovery = (c: string) => crypto.createHash('sha256').update(c.toUpperCase().replace(/\s/g, '')).digest('hex');

/** Token de convite/redefinição: o link leva o token; o banco guarda só o hash. */
export const newLinkToken = () => crypto.randomBytes(32).toString('base64url');
export const hashLinkToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
