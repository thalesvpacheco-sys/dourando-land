import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ROLES, type Role } from '@dl/shared';
import { config } from '../config.js';
import { db } from '../db/knex.js';
import { HttpError, forbidden } from '../lib/http.js';
import { grant, PRIVILEGED, type Action, type Resource, type Scope } from './permissions.js';

export interface AuthUser {
  id: string;
  externalId: string;
  orgId: string;
  /** Organização dona dos dados que o usuário opera. Para compradores, é a gestora (Dourado) que os cadastrou como parceiros. */
  dataOrgId: string;
  role: Role;
  name: string;
  email: string;
  brokerId: string | null;
  partnerCompanyIds: string[];
  mfa: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

/** Claims esperadas do JWT emitido pela identidade WingsBr. */
interface Claims { sub: string; org: string; role: Role; name: string; email: string; amr?: string[] }

export function signDevToken(c: Claims, ttl = '8h') {
  return jwt.sign(c, config.jwtSecret, { algorithm: 'HS256', issuer: config.jwtIssuer, expiresIn: ttl } as jwt.SignOptions);
}

async function loadUser(c: Claims): Promise<AuthUser> {
  if (!(c.role in ROLES)) throw new HttpError(401, 'Papel inválido no token');
  const org = await db('organizations').where({ id: c.org }).first();
  if (!org) throw new HttpError(401, 'Organização desconhecida');
  let u = await db('users').where({ external_id: c.sub }).first();
  if (!u) {
    // Provisionamento JIT a partir da identidade WingsBr
    [u] = await db('users').insert({ external_id: c.sub, org_id: c.org, name: c.name, email: c.email, role: c.role }).returning('*');
  }
  if (!u.active) throw new HttpError(401, 'Usuário desativado');
  if (u.org_id !== c.org) throw new HttpError(401, 'Token não corresponde à organização do usuário');
  const broker = u.role === 'broker' ? await db('land_brokers').where({ user_id: u.id }).first() : null;
  const partnerRows = u.role === 'buyer' ? await db('partner_companies').where({ partner_org_id: u.org_id }).select('id', 'org_id') : [];
  const partners = partnerRows.map((p: any) => p.id);
  return {
    id: u.id, externalId: c.sub, orgId: u.org_id, dataOrgId: partnerRows[0]?.org_id ?? u.org_id, role: u.role, name: u.name, email: u.email,
    brokerId: broker?.id ?? null, partnerCompanyIds: partners, mfa: (c.amr ?? []).includes('mfa'),
  };
}

function extractToken(req: Request) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return null;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next(new HttpError(401, 'Autenticação necessária'));
  try {
    const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: config.jwtIssuer }) as Claims;
    req.user = await loadUser(claims);
    if (config.requireMfa && PRIVILEGED.includes(req.user.role) && !req.user.mfa) {
      return next(new HttpError(401, 'Autenticação multifator obrigatória para este perfil'));
    }
    next();
  } catch (e) {
    next(e instanceof HttpError ? e : new HttpError(401, 'Token inválido ou expirado'));
  }
}

/** Autenticação opcional (rotas públicas que se enriquecem com login, ex.: vitrine privada). */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  if (!extractToken(req)) return next();
  return authenticate(req, _res, (err?: unknown) => (err ? next() : next()));
}

export function requireScope(req: Request, resource: Resource, action: Action): Scope {
  const u = req.user;
  if (!u) throw new HttpError(401, 'Autenticação necessária');
  const s = grant(u.role, resource, action);
  if (!s) throw forbidden(`Seu perfil não pode ${action} ${resource}`);
  return s;
}

export const can = (req: Request, resource: Resource, action: Action) => !!req.user && !!grant(req.user.role, resource, action);
