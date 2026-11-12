import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// server/.env (desenvolvimento local). Variáveis já definidas no ambiente têm precedência; os testes não leem o arquivo.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (process.env.NODE_ENV !== 'test' && fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name: string, devDefault: string): string {
  const v = env[name];
  if (v) return v;
  if (isProd) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return devDefault;
}

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT ?? 4200),
  databaseUrl: required('DATABASE_URL', 'postgres://dl:dl@localhost:5432/dourado'),
  publicWebUrl: env.PUBLIC_WEB_URL ?? 'http://localhost:5174',
  // Segredo de assinatura das sessões. WINGSBR_JWT_SECRET continua aceito por compatibilidade.
  jwtSecret: env.AUTH_JWT_SECRET || env.WINGSBR_JWT_SECRET || required('AUTH_JWT_SECRET', 'dev-secret-nao-usar-em-producao'),
  jwtIssuer: env.AUTH_JWT_ISSUER ?? env.WINGSBR_JWT_ISSUER ?? 'wingsbr',
  // Duas etapas (aplicativo autenticador): desligado. REQUIRE_MFA=true volta a exigir de administradores.
  requireMfa: env.REQUIRE_MFA === 'true',
  sessionHours: Number(env.SESSION_HOURS ?? 12),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  smtpUrl: env.SMTP_URL || null,
  mailFrom: env.MAIL_FROM ?? 'Dourado Land Intelligence <no-reply@douradoimob.com.br>',
  // Build do front servido pela própria API (mesma origem, sem CORS)
  webDist: env.WEB_DIST_DIR ? path.resolve(env.WEB_DIST_DIR) : null,
  // Hosts extras na política de segurança (ex.: provedor de mapas)
  cspExtraHosts: (env.CSP_EXTRA_HOSTS ?? '').split(/[\s,]+/).filter(Boolean),
  dataKey: Buffer.from(required('DATA_KEY', crypto.createHash('sha256').update('dev-data-key').digest('hex')), 'hex'),
  crmUrl: env.WINGSBR_CRM_URL || null,
  crmSecret: env.WINGSBR_CRM_SECRET ?? '',
  waVerifyToken: env.WHATSAPP_VERIFY_TOKEN ?? 'dev-verify',
  waAppSecret: env.WHATSAPP_APP_SECRET ?? 'dev-app-secret',
  storageDir: path.resolve(env.STORAGE_DIR ?? './storage'),
  anthropicKey: env.ANTHROPIC_API_KEY || null,
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
  // Seletor de usuários: só em desenvolvimento/teste, e nunca se NODE_ENV=production.
  enableDevLogin: !isProd && (env.ENABLE_DEV_LOGIN === 'true' || env.NODE_ENV === 'test'),
  // Criar usuário a partir de um token externo (identidade WingsBr): desligado com o login próprio.
  allowJitProvisioning: !isProd && (env.ENABLE_DEV_LOGIN === 'true' || env.NODE_ENV === 'test'),
};
