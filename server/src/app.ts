import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { db } from './db/knex.js';
import { authenticate, requireScope, signDevToken } from './auth/auth.js';
import { ah, errorHandler, notFound, parse } from './lib/http.js';
import { audit } from './lib/audit.js';
import { normalizePhone } from './lib/crypto.js';
import { router as opportunities, documentsRouter } from './routes/opportunities.js';
import { router as publicRouter, filesRouter } from './routes/public.js';
import { router as interests, webhookRouter } from './routes/interests.js';
import { router as negotiations, proposalsRouter } from './routes/negotiations.js';
import { router as matching } from './routes/matching.js';
import { router as dashboard } from './routes/dashboard.js';
import { router as admin } from './routes/admin.js';
import { router as ai, publicAiRouter } from './routes/ai.js';
import { router as prospects, territoryRouter } from './routes/prospects.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.isProd ? config.publicWebUrl : true, credentials: false }));

  // webhook precisa do corpo bruto para validar a assinatura — registrado antes do parser JSON
  app.use('/webhooks', webhookRouter);
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', ah(async (_req, res) => {
    await db.raw('select 1');
    res.json({ ok: true, postgis: (await db.raw('select postgis_lib_version() as v')).rows[0].v });
  }));

  // mídia pública (WebP sem metadados)
  app.use('/media', express.static(path.join(config.storageDir, 'media'), { maxAge: '7d', immutable: true, fallthrough: true, dotfiles: 'deny' }));

  app.use('/media', (_req, res) => res.status(404).end());
  app.use('/api/public', publicRouter);
  app.use('/api/public/ai', publicAiRouter);
  app.use('/api/files', filesRouter);

  // login de demonstração: emite tokens no formato da identidade WingsBr (desligado em produção)
  if (config.enableDevLogin) {
    const loginLimiter = rateLimit({ windowMs: 60_000, limit: 60 });
    app.get('/api/dev/users', ah(async (_req, res) => {
      res.json({ items: await db('users as u').join('organizations as o', 'o.id', 'u.org_id').where('u.active', true).select('u.id', 'u.name', 'u.email', 'u.role', 'o.name as org_name').orderBy('u.role') });
    }));
    app.post('/api/dev/login', loginLimiter, ah(async (req, res) => {
      const { user_id } = parse(z.object({ user_id: z.string().uuid() }), req.body);
      const u = await db('users').where({ id: user_id, active: true }).first();
      if (!u) throw notFound('Usuário');
      res.json({ token: signDevToken({ sub: u.external_id, org: u.org_id, role: u.role, name: u.name, email: u.email, amr: ['pwd', 'mfa'] }) });
    }));
  }

  const api = Router();
  api.use('/opportunities', opportunities);
  api.use('/documents', documentsRouter);
  api.use('/interests', interests);
  api.use('/negotiations', negotiations);
  api.use('/proposals', proposalsRouter);
  api.use('/', matching);
  api.use('/dashboard', dashboard);
  api.use('/admin', admin);
  api.use('/ai', ai);
  api.use('/prospects', prospects);
  api.use('/territory', territoryRouter);

  // direitos do titular (LGPD): anonimiza interesses e negociações de um contato
  api.post('/privacy/erase', authenticate, ah(async (req, res) => {
    requireScope(req, 'interest', 'delete');
    const b = parse(z.object({ email: z.string().email().optional(), phone: z.string().optional(), reason: z.string().min(3) }), req.body);
    const phone = normalizePhone(b.phone);
    const where = (qb: any, e: string, p: string) => qb.where((w: any) => { if (b.email) w.orWhere(e, b.email.toLowerCase()); if (phone) w.orWhere(p, phone); });
    const n1 = await where(db('opportunity_interests').where({ org_id: req.user!.orgId }), 'email', 'phone')
      .update({ name: 'Titular anonimizado', email: null, phone: null, company: null, message: null, attribution: '{}', ip_hash: null });
    const n2 = await where(db('negotiations').where({ org_id: req.user!.orgId }), 'contact_email', 'contact_phone')
      .update({ contact_name: 'Titular anonimizado', contact_email: null, contact_phone: null });
    await audit(req, 'privacy.erase', 'data_subject', null, { reason: b.reason, interests: n1, negotiations: n2 });
    res.json({ interests: n1, negotiations: n2, note: 'Solicite também a exclusão no WingsBr CRM (fonte dos contatos).' });
  }));

  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
