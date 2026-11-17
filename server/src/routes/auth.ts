/**
 * Login próprio: senha + segunda etapa (TOTP) obrigatória para perfis administrativos.
 * A sessão fica em cookie HttpOnly; o front não tem acesso ao token.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/knex.js';
import { SESSION_COOKIE, authenticate, optionalAuth, signSession } from '../auth/auth.js';
import { MATRIX, PRIVILEGED } from '../auth/permissions.js';
import {
  hashLinkToken, hashPassword, hashRecovery, newRecoveryCodes, newTotpSecret, otpauthUrl, passwordProblem, verifyPassword, verifyTotp,
} from '../auth/credentials.js';
import { createAuthLink, resetText } from '../auth/links.js';
import { ah, badRequest, HttpError, parse } from '../lib/http.js';
import { decrypt, encrypt, hashIp } from '../lib/crypto.js';
import { sendMail } from '../lib/mailer.js';

export const router = Router();

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const BAD_LOGIN = 'E-mail ou senha incorretos. Depois de 5 tentativas, o acesso fica bloqueado por 15 minutos.';

const limiter = (limit: number) => rateLimit({ windowMs: 15 * 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => config.isTest, message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } });
const loginLimiter = limiter(30);
const linkLimiter = limiter(20);

// A etapa intermediária usa uma chave derivada: um desafio nunca serve como sessão, nem o contrário.
const challengeKey = () => crypto.createHmac('sha256', config.jwtSecret).update('mfa-challenge').digest();
const signChallenge = (u: any) => jwt.sign({ uid: u.id, sv: u.session_version }, challengeKey(), { algorithm: 'HS256', expiresIn: '10m' });

async function fromChallenge(token: string) {
  let c: any;
  try { c = jwt.verify(token, challengeKey(), { algorithms: ['HS256'] }); } catch { throw new HttpError(401, 'Etapa expirada. Entre novamente.'); }
  const u = await db('users').where({ id: c.uid, active: true }).first();
  if (!u || u.session_version !== c.sv) throw new HttpError(401, 'Etapa expirada. Entre novamente.');
  return u;
}

async function logEvent(req: Request, action: string, u: any | null, extra?: unknown) {
  await db('audit_logs').insert({
    org_id: u?.org_id ?? null, user_id: u?.id ?? null, action, entity: 'users', entity_id: u?.id ?? null,
    diff: extra === undefined ? null : JSON.stringify(extra), ip_hash: hashIp(req.ip),
  });
}

async function startSession(req: Request, res: Response, u: any, mfa: boolean) {
  await db('users').where({ id: u.id }).update({ failed_logins: 0, locked_until: null, last_login_at: db.fn.now() });
  await logEvent(req, 'auth.login', u, { mfa });
  res.cookie(SESSION_COOKIE, signSession(u, mfa), { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/', maxAge: config.sessionHours * 3600_000 });
}

const isLocked = (u: any) => u.locked_until && new Date(u.locked_until).getTime() > Date.now();

async function registerFailure(req: Request, u: any) {
  const fails = (u.failed_logins ?? 0) + 1;
  const lock = fails >= MAX_FAILS;
  await db('users').where({ id: u.id }).update({ failed_logins: lock ? 0 : fails, locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null });
  await logEvent(req, lock ? 'auth.locked' : 'auth.failed', u);
}

// ------------------------------------------------------------------ sessão

router.get('/session', optionalAuth, ah(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return void res.json({ authenticated: false });
  const org = await db('organizations').where({ id: req.user.orgId }).select('id', 'name', 'slug', 'kind', 'central_whatsapp').first();
  res.json({ authenticated: true, user: req.user, org, permissions: MATRIX[req.user.role], mfaRequired: config.requireMfa });
}));

router.post('/login', loginLimiter, ah(async (req, res) => {
  const b = parse(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }), req.body);
  const u = await db('users').whereRaw('lower(email) = ?', [b.email.trim().toLowerCase()]).first();
  const ok = await verifyPassword(b.password, u?.password_hash);
  if (!u || !u.active || !u.password_hash) { await logEvent(req, 'auth.failed', null); throw new HttpError(401, BAD_LOGIN); }
  if (isLocked(u)) throw new HttpError(429, 'Acesso bloqueado temporariamente por tentativas incorretas. Tente de novo em alguns minutos.');
  if (!ok) { await registerFailure(req, u); throw new HttpError(401, BAD_LOGIN); }

  // Com REQUIRE_MFA desligado o login é só com senha, mesmo para quem já tinha ativado.
  if (config.requireMfa) {
    if (u.mfa_enabled) return void res.json({ step: 'mfa', challenge: signChallenge(u) });
    if (PRIVILEGED.includes(u.role)) return void res.json({ step: 'mfa_setup', challenge: signChallenge(u) });
  }
  await startSession(req, res, u, false);
  res.json({ step: 'done' });
}));

router.post('/logout', ah(async (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/' });
  res.status(204).end();
}));

// ------------------------------------------------------------------ segunda etapa

router.post('/mfa/verify', loginLimiter, ah(async (req, res) => {
  const b = parse(z.object({ challenge: z.string(), code: z.string().min(6).max(20) }), req.body);
  const u = await fromChallenge(b.challenge);
  if (isLocked(u)) throw new HttpError(429, 'Acesso bloqueado temporariamente por tentativas incorretas. Tente de novo em alguns minutos.');
  const secret = decrypt(u.mfa_secret_enc);
  const step = secret && u.mfa_enabled ? verifyTotp(secret, b.code, Number(u.mfa_last_step)) : null;
  if (step) {
    await db('users').where({ id: u.id }).update({ mfa_last_step: step });
  } else {
    const hash = hashRecovery(b.code);
    const codes: string[] = u.mfa_recovery_hashes ?? [];
    if (!u.mfa_enabled || !codes.includes(hash)) { await registerFailure(req, u); throw new HttpError(401, 'Código incorreto.'); }
    await db('users').where({ id: u.id }).update({ mfa_recovery_hashes: JSON.stringify(codes.filter((c) => c !== hash)) });
    await logEvent(req, 'auth.recovery_code', u, { remaining: codes.length - 1 });
  }
  await startSession(req, res, u, true);
  res.json({ step: 'done' });
}));

/** Quem está ativando: pelo desafio do login (primeiro acesso de administrador) ou pela sessão (Minha conta). */
async function mfaActor(req: Request, challenge?: string) {
  if (challenge) return fromChallenge(challenge);
  await new Promise<void>((ok, fail) => authenticate(req, {} as Response, (e?: unknown) => (e ? fail(e) : ok())));
  return db('users').where({ id: req.user!.id }).first();
}

router.post('/mfa/setup', loginLimiter, ah(async (req, res) => {
  const b = parse(z.object({ challenge: z.string().optional() }), req.body ?? {});
  const u = await mfaActor(req, b.challenge);
  if (u.mfa_enabled) throw badRequest('A verificação em duas etapas já está ativa.');
  // Reaproveita o segredo pendente: recarregar a tela não pode invalidar o QR já escaneado.
  let secret = u.mfa_secret_enc ? decrypt(u.mfa_secret_enc) : null;
  if (!secret) {
    secret = newTotpSecret();
    await db('users').where({ id: u.id }).update({ mfa_secret_enc: encrypt(secret) });
  }
  const url = otpauthUrl(secret, u.email);
  res.json({ secret, otpauth: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
}));

router.post('/mfa/activate', loginLimiter, ah(async (req, res) => {
  const b = parse(z.object({ challenge: z.string().optional(), code: z.string().min(6).max(8) }), req.body);
  const u = await mfaActor(req, b.challenge);
  const secret = decrypt(u.mfa_secret_enc);
  if (!secret || u.mfa_enabled) throw badRequest('Comece a configuração novamente.');
  const step = verifyTotp(secret, b.code, Number(u.mfa_last_step));
  if (!step) throw new HttpError(401, 'Código incorreto. Confira o relógio do celular e tente o código seguinte.');
  const codes = newRecoveryCodes();
  await db('users').where({ id: u.id }).update({ mfa_enabled: true, mfa_last_step: step, mfa_recovery_hashes: JSON.stringify(codes.map(hashRecovery)) });
  await logEvent(req, 'auth.mfa_enabled', u);
  await startSession(req, res, { ...u, mfa_enabled: true }, true);
  res.json({ step: 'done', recovery_codes: codes });
}));

router.post('/mfa/disable', authenticate, ah(async (req, res) => {
  const b = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
  const u = await db('users').where({ id: req.user!.id }).first();
  if (PRIVILEGED.includes(u.role) && config.requireMfa) throw badRequest('Este perfil precisa manter a verificação em duas etapas.');
  if (!(await verifyPassword(b.password, u.password_hash))) throw new HttpError(401, 'Senha incorreta.');
  await db('users').where({ id: u.id }).update({ mfa_enabled: false, mfa_secret_enc: null, mfa_recovery_hashes: '[]' });
  await logEvent(req, 'auth.mfa_disabled', u);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ convite, redefinição e troca de senha

async function validLink(token: string) {
  const t = await db('auth_tokens').where({ token_hash: hashLinkToken(token) }).whereNull('used_at').where('expires_at', '>', db.fn.now()).first();
  if (!t) throw badRequest('Este link expirou ou já foi usado. Peça um novo ao administrador.');
  const u = await db('users').where({ id: t.user_id, active: true }).first();
  if (!u) throw badRequest('Este link expirou ou já foi usado. Peça um novo ao administrador.');
  return { t, u };
}

router.post('/link/check', linkLimiter, ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
  const { t, u } = await validLink(b.token);
  res.json({ kind: t.kind, name: u.name, email: u.email });
}));

router.post('/password/set', linkLimiter, ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(20).max(200), password: z.string().max(200) }), req.body);
  const { t, u } = await validLink(b.token);
  const problem = passwordProblem(b.password, u.email);
  if (problem) throw badRequest(problem);
  const hash = await hashPassword(b.password);
  await db.transaction(async (trx) => {
    await trx('auth_tokens').where({ id: t.id }).update({ used_at: trx.fn.now() });
    await trx('users').where({ id: u.id }).update({
      password_hash: hash, password_changed_at: trx.fn.now(), failed_logins: 0, locked_until: null, session_version: u.session_version + 1, updated_at: trx.fn.now(),
    });
  });
  await logEvent(req, t.kind === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset', u);
  res.json({ ok: true });
}));

router.post('/password/forgot', linkLimiter, ah(async (req, res) => {
  const b = parse(z.object({ email: z.string().email().max(200) }), req.body);
  const u = await db('users').whereRaw('lower(email) = ?', [b.email.trim().toLowerCase()]).where({ active: true }).first();
  // Mesma resposta exista ou não a conta. Sem SMTP, o administrador gera o link em Usuários.
  if (u?.password_hash) {
    const link = await createAuthLink(u.id, 'reset', null);
    await sendMail(u.email, 'Redefinir senha — Quero Área', resetText(u.name, link.url));
    await logEvent(req, 'auth.reset_requested', u);
  }
  res.json({ ok: true });
}));

router.post('/password/change', loginLimiter, authenticate, ah(async (req, res) => {
  const b = parse(z.object({ current: z.string().min(1).max(200), password: z.string().max(200) }), req.body);
  const u = await db('users').where({ id: req.user!.id }).first();
  if (!(await verifyPassword(b.current, u.password_hash))) { await registerFailure(req, u); throw new HttpError(401, 'Senha atual incorreta.'); }
  const problem = passwordProblem(b.password, u.email);
  if (problem) throw badRequest(problem);
  const sv = u.session_version + 1;
  await db('users').where({ id: u.id }).update({ password_hash: await hashPassword(b.password), password_changed_at: db.fn.now(), session_version: sv, updated_at: db.fn.now() });
  await logEvent(req, 'auth.password_changed', u);
  // encerra as outras sessões e mantém esta
  await startSession(req, res, { ...u, session_version: sv }, req.user!.mfa);
  res.json({ ok: true });
}));


