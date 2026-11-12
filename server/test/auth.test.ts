/** Login próprio: convite, senha, duas etapas, bloqueio, revogação e controle de usuários. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { db } from '../src/db/knex.js';
import { seed } from '../src/db/seed.js';
import { signDevToken } from '../src/auth/auth.js';
import { currentStep, hashPassword, passwordProblem, totpAt, verifyPassword, verifyTotp } from '../src/auth/credentials.js';

const app = createApp();
const PW = 'Gleba-Goianira-2026';
let adminTok: string;
const asAdmin = () => ({ Authorization: `Bearer ${adminTok}` });
const tokenOf = (url: string) => url.split('#')[1];
const cookieOf = (res: any) => (res.headers['set-cookie'] as string[]).find((c) => c.startsWith('dl_session=')) ?? '';
const sessionCookie = (res: any) => cookieOf(res).split(';')[0];

async function invite(email: string, role = 'broker', extra: any = {}) {
  const r = await request(app).post('/api/admin/users').set(asAdmin()).send({ name: 'Pessoa Teste', email, role, ...extra });
  expect(r.status).toBe(201);
  return r.body;
}
async function activate(email: string, role = 'broker') {
  const inv = await invite(email, role);
  const s = await request(app).post('/api/auth/password/set').send({ token: tokenOf(inv.invite_url), password: PW });
  expect(s.status).toBe(200);
  return inv.id as string;
}

beforeAll(async () => {
  await seed();
  const u = await db('users').where({ email: 'marina@dourado.example' }).first();
  adminTok = signDevToken({ sub: u.external_id, org: u.org_id, role: u.role, name: u.name, email: u.email, amr: ['mfa'] });
});
afterAll(async () => { await db.destroy(); });

describe('Credenciais', () => {
  it('hash de senha verifica e não guarda a senha', async () => {
    const h = await hashPassword(PW);
    expect(h).not.toContain(PW);
    expect(await verifyPassword(PW, h)).toBe(true);
    expect(await verifyPassword('outra-senha-qualquer', h)).toBe(false);
    expect(await verifyPassword(PW, null)).toBe(false);
  });
  it('política de senha', () => {
    expect(passwordProblem('curta')).toMatch(/10/);
    expect(passwordProblem('1234567890')).toBeTruthy();
    expect(passwordProblem('marina.dourado123', 'marina.dourado@x.com')).toMatch(/e-mail/);
    expect(passwordProblem(PW)).toBeNull();
  });
  it('TOTP segue o vetor do RFC 6238 e não aceita código repetido', () => {
    // segredo do RFC ("12345678901234567890" em base32), T = 59s → 287082 nos 6 últimos dígitos
    const s = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpAt(s, 1)).toBe('287082');
    const now = Date.now(), step = currentStep(now), code = totpAt(s, step);
    expect(verifyTotp(s, code, 0, now)).toBe(step);
    expect(verifyTotp(s, code, step, now)).toBeNull();
    expect(verifyTotp(s, '000000x', 0, now)).toBeNull();
  });
});

describe('Convite e login', () => {
  it('convite: link de uso único, sem senha até aceitar; login cria cookie HttpOnly e SameSite', async () => {
    const inv = await invite('nova.corretora@dourado.example');
    expect(inv.invite_url).toContain('/painel/definir-senha#');
    const row = await db('auth_tokens').where({ user_id: inv.id }).first();
    expect(row.token_hash).not.toContain(tokenOf(inv.invite_url)); // banco guarda só o hash

    expect((await request(app).post('/api/auth/login').send({ email: 'nova.corretora@dourado.example', password: PW })).status).toBe(401);
    const check = await request(app).post('/api/auth/link/check').send({ token: tokenOf(inv.invite_url) });
    expect(check.body).toMatchObject({ kind: 'invite', email: 'nova.corretora@dourado.example' });
    expect((await request(app).post('/api/auth/password/set').send({ token: tokenOf(inv.invite_url), password: 'curta' })).status).toBe(400);
    expect((await request(app).post('/api/auth/password/set').send({ token: tokenOf(inv.invite_url), password: PW })).status).toBe(200);
    expect((await request(app).post('/api/auth/password/set').send({ token: tokenOf(inv.invite_url), password: PW })).status).toBe(400); // uso único

    const login = await request(app).post('/api/auth/login').send({ email: 'NOVA.corretora@dourado.example', password: PW });
    expect(login.body.step).toBe('done');
    const c = cookieOf(login);
    expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/SameSite=Strict/i);
    const s = await request(app).get('/api/auth/session').set('Cookie', sessionCookie(login));
    expect(s.body).toMatchObject({ authenticated: true, user: { role: 'broker' } });
    expect((await request(app).get('/api/interests').set('Cookie', sessionCookie(login))).status).toBe(200);
    const out = await request(app).post('/api/auth/logout').set('Cookie', sessionCookie(login));
    expect(out.status).toBe(204);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(/dl_session=;/);
    expect((await request(app).get('/api/auth/session')).body.authenticated).toBe(false);
  });

  it('e-mail desconhecido e senha errada têm a mesma resposta; 5 erros bloqueiam a conta', async () => {
    await activate('bloqueio@dourado.example');
    const unknown = await request(app).post('/api/auth/login').send({ email: 'ninguem@dourado.example', password: PW });
    const wrong = await request(app).post('/api/auth/login').send({ email: 'bloqueio@dourado.example', password: 'senha-errada-aqui' });
    expect(unknown.status).toBe(401); expect(wrong.status).toBe(401);
    expect(unknown.body.error).toBe(wrong.body.error);
    for (let i = 0; i < 4; i++) await request(app).post('/api/auth/login').send({ email: 'bloqueio@dourado.example', password: 'senha-errada-aqui' });
    const locked = await request(app).post('/api/auth/login').send({ email: 'bloqueio@dourado.example', password: PW });
    expect(locked.status).toBe(429); // nem a senha certa entra
    await db('users').where({ email: 'bloqueio@dourado.example' }).update({ locked_until: new Date(Date.now() - 1000) });
    expect((await request(app).post('/api/auth/login').send({ email: 'bloqueio@dourado.example', password: PW })).status).toBe(200);
  });

  it('esqueci a senha não revela se a conta existe', async () => {
    const a = await request(app).post('/api/auth/password/forgot').send({ email: 'ninguem@dourado.example' });
    const b = await request(app).post('/api/auth/password/forgot').send({ email: 'bloqueio@dourado.example' });
    expect(a.status).toBe(200); expect(a.body).toEqual(b.body);
  });

  it('trocar a senha encerra as sessões anteriores; desativar encerra na hora', async () => {
    const id = await activate('sessoes@dourado.example');
    const l1 = await request(app).post('/api/auth/login').send({ email: 'sessoes@dourado.example', password: PW });
    const old = sessionCookie(l1);
    const ch = await request(app).post('/api/auth/password/change').set('Cookie', old).send({ current: PW, password: 'Outra-Senha-Forte-99' });
    expect(ch.status).toBe(200);
    expect((await request(app).get('/api/interests').set('Cookie', old)).status).toBe(401);
    const fresh = sessionCookie(ch);
    expect((await request(app).get('/api/interests').set('Cookie', fresh)).status).toBe(200);
    await request(app).patch(`/api/admin/users/${id}`).set(asAdmin()).send({ active: false }).expect(200);
    expect((await request(app).get('/api/interests').set('Cookie', fresh)).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'sessoes@dourado.example', password: 'Outra-Senha-Forte-99' })).status).toBe(401);
  });
});

describe('Duas etapas', () => {
  it('administrador precisa configurar antes de ter sessão; depois o código é exigido e não repete', async () => {
    (config as any).requireMfa = true;
    try {
      const id = await activate('admin.mfa@dourado.example', 'dourado_admin');
      const l = await request(app).post('/api/auth/login').send({ email: 'admin.mfa@dourado.example', password: PW });
      expect(l.body.step).toBe('mfa_setup');
      expect(l.headers['set-cookie']).toBeUndefined();
      // o desafio não vale como sessão
      expect((await request(app).get('/api/opportunities').set({ Authorization: `Bearer ${l.body.challenge}` })).status).toBe(401);
      expect((await request(app).get('/api/auth/session').set({ Authorization: `Bearer ${l.body.challenge}` })).body.authenticated).toBe(false);

      const setup = await request(app).post('/api/auth/mfa/setup').send({ challenge: l.body.challenge });
      expect(setup.body.qr).toMatch(/^data:image\/png/);
      const stored = await db('users').where({ id }).first();
      expect(stored.mfa_secret_enc).not.toContain(setup.body.secret);

      expect((await request(app).post('/api/auth/mfa/activate').send({ challenge: l.body.challenge, code: '000000' })).status).toBe(401);
      const code = totpAt(setup.body.secret, currentStep());
      const act = await request(app).post('/api/auth/mfa/activate').send({ challenge: l.body.challenge, code });
      expect(act.status).toBe(200);
      expect(act.body.recovery_codes).toHaveLength(8);
      const sess = sessionCookie(act);
      expect((await request(app).get('/api/opportunities').set('Cookie', sess)).status).toBe(200);

      const l2 = await request(app).post('/api/auth/login').send({ email: 'admin.mfa@dourado.example', password: PW });
      expect(l2.body.step).toBe('mfa');
      expect((await request(app).post('/api/auth/mfa/verify').send({ challenge: l2.body.challenge, code })).status).toBe(401); // repetição
      const rec = act.body.recovery_codes[0];
      const v = await request(app).post('/api/auth/mfa/verify').send({ challenge: l2.body.challenge, code: rec });
      expect(v.status).toBe(200);
      expect((await request(app).post('/api/auth/mfa/verify').send({ challenge: l2.body.challenge, code: rec })).status).toBe(401); // código de recuperação é único
      const left = await db('users').where({ id }).first();
      expect(left.mfa_recovery_hashes).toHaveLength(7);

      // zerar pelo outro administrador encerra sessões e volta a exigir configuração
      await request(app).post(`/api/admin/users/${id}/reset-mfa`).set(asAdmin()).expect(200);
      expect((await request(app).get('/api/opportunities').set('Cookie', sess)).status).toBe(401);
      const l3 = await request(app).post('/api/auth/login').send({ email: 'admin.mfa@dourado.example', password: PW });
      expect(l3.body.step).toBe('mfa_setup');
    } finally { (config as any).requireMfa = false; }
  });

  it('sessão sem o segundo fator é recusada para perfil administrativo', async () => {
    (config as any).requireMfa = true;
    try {
      const u = await db('users').where({ email: 'marina@dourado.example' }).first();
      const noMfa = signDevToken({ sub: u.external_id, org: u.org_id, role: u.role, name: u.name, email: u.email, amr: ['pwd'], sv: u.session_version });
      expect((await request(app).get('/api/opportunities').set({ Authorization: `Bearer ${noMfa}` })).status).toBe(401);
    } finally { (config as any).requireMfa = false; }
  });
});

describe('Controle de usuários', () => {
  it('só administrador convida; ninguém concede acima do próprio nível', async () => {
    const br = await db('users').where({ email: 'juliana@parceiros.example' }).first();
    const brokerTok = signDevToken({ sub: br.external_id, org: br.org_id, role: br.role, name: br.name, email: br.email });
    const capt = await db('users').where({ email: 'carlos@dourado.example' }).first();
    const captTok = signDevToken({ sub: capt.external_id, org: capt.org_id, role: capt.role, name: capt.name, email: capt.email, amr: ['mfa'] });
    expect((await request(app).post('/api/admin/users').set({ Authorization: `Bearer ${brokerTok}` }).send({ name: 'X Y', email: 'x@y.example', role: 'broker' })).status).toBe(403);
    expect((await request(app).post('/api/admin/users').set({ Authorization: `Bearer ${captTok}` }).send({ name: 'X Y', email: 'x@y.example', role: 'broker' })).status).toBe(403);
    expect((await request(app).get('/api/admin/users').set({ Authorization: `Bearer ${brokerTok}` })).status).toBe(403);
    expect((await request(app).post('/api/admin/users').set(asAdmin()).send({ name: 'X Y', email: 'x@y.example', role: 'platform_admin' })).status).toBe(403);
    const ana = await db('users').where({ email: 'ana@wingsbr.example' }).first();
    expect((await request(app).patch(`/api/admin/users/${ana.id}`).set(asAdmin()).send({ active: false })).status).toBe(404); // fora da organização
  });

  it('e-mail é único; corretor ganha cadastro de intermediador; comprador e proprietário ficam vinculados', async () => {
    expect((await request(app).post('/api/admin/users').set(asAdmin()).send({ name: 'Dup', email: 'MARINA@dourado.example', role: 'broker' })).status).toBe(409);
    const b = await invite('corretor.novo@dourado.example', 'broker', { phone: '62999990000' });
    expect(await db('land_brokers').where({ user_id: b.id }).first()).toMatchObject({ whatsapp: '62999990000' });

    expect((await request(app).post('/api/admin/users').set(asAdmin()).send({ name: 'Comp', email: 'c@novo.example', role: 'buyer' })).status).toBe(400);
    const pc = (await request(app).get('/api/partners').set(asAdmin())).body.items.find((p: any) => !p.partner_org_id);
    const buyer = await invite('comprador.novo@novo.example', 'buyer', { partner_company_id: pc.id });
    const bu = await db('users').where({ id: buyer.id }).first();
    expect(bu.org_id).toBe((await db('partner_companies').where({ id: pc.id }).first()).partner_org_id);

    expect((await request(app).post('/api/admin/users').set(asAdmin()).send({ name: 'Prop', email: 'p@novo.example', role: 'owner', opportunity_code: 'DOU-XX-9999' })).status).toBe(400);
    const owner = await invite('proprietario.novo@novo.example', 'owner', { opportunity_code: 'DOU-GO-0001' });
    expect(await db('land_owners').where({ user_id: owner.id }).first()).toBeTruthy();
  });

  it('não dá para desativar a si mesmo nem ficar sem administrador', async () => {
    const me = await db('users').where({ email: 'marina@dourado.example' }).first();
    expect((await request(app).patch(`/api/admin/users/${me.id}`).set(asAdmin()).send({ active: false })).status).toBe(400);
    // admin ativo com senha é só quem já definiu: marina (sem senha) ainda não conta como alternativa
    const other = await activate('segundo.admin@dourado.example', 'dourado_admin');
    await db('users').where({ role: 'dourado_admin' }).whereNot({ id: other }).update({ password_hash: null });
    const tok = signDevToken({ sub: me.external_id, org: me.org_id, role: me.role, name: me.name, email: me.email, amr: ['mfa'] });
    const r = await request(app).patch(`/api/admin/users/${other}`).set({ Authorization: `Bearer ${tok}` }).send({ active: false });
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/último administrador/);
  });

  it('link de redefinição: gerado pelo admin, expira, e a senha antiga para de valer', async () => {
    const id = await activate('reset@dourado.example');
    const l = await request(app).post(`/api/admin/users/${id}/link`).set(asAdmin());
    expect(l.body.kind).toBe('reset');
    await db('auth_tokens').where({ user_id: id, kind: 'reset' }).update({ expires_at: new Date(Date.now() - 1000) });
    expect((await request(app).post('/api/auth/password/set').send({ token: tokenOf(l.body.url), password: 'Nova-Senha-Forte-77' })).status).toBe(400);
    const l2 = await request(app).post(`/api/admin/users/${id}/link`).set(asAdmin());
    expect((await request(app).post('/api/auth/password/set').send({ token: tokenOf(l2.body.url), password: 'Nova-Senha-Forte-77' })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: 'reset@dourado.example', password: PW })).status).toBe(401);
  });
});

describe('Produção', () => {
  it('sem seletor de usuários, sem criar conta por token e sem token antigo', async () => {
    const flags = { dev: config.enableDevLogin, jit: config.allowJitProvisioning };
    (config as any).enableDevLogin = false; (config as any).allowJitProvisioning = false;
    try {
      const prod = createApp();
      expect([401, 404]).toContain((await request(prod).get('/api/dev/users')).status);
      expect([401, 404]).toContain((await request(prod).post('/api/dev/login').send({ user_id: '00000000-0000-0000-0000-000000000000' })).status);
      const org = await db('organizations').where({ slug: 'dourado' }).first();
      const forged = jwt.sign({ sub: 'wb_inexistente', org: org.id, role: 'dourado_admin', name: 'Invasor', email: 'i@x.example', amr: ['mfa'] }, config.jwtSecret, { algorithm: 'HS256', issuer: config.jwtIssuer });
      expect((await request(prod).get('/api/opportunities').set({ Authorization: `Bearer ${forged}` })).status).toBe(401);
      expect(await db('users').where({ external_id: 'wb_inexistente' }).first()).toBeUndefined();
      // token sem versão de sessão (formato antigo) não entra
      const u = await db('users').where({ email: 'carlos@dourado.example' }).first();
      expect((await request(prod).get('/api/opportunities').set({ Authorization: `Bearer ${signDevToken({ sub: u.external_id, org: u.org_id, role: u.role, name: u.name, email: u.email, amr: ['mfa'] })}` })).status).toBe(401);
      expect((await request(prod).get('/api/admin/users')).status).toBe(401);
    } finally { (config as any).enableDevLogin = flags.dev; (config as any).allowJitProvisioning = flags.jit; }
  });
});
