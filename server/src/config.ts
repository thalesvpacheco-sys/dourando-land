import crypto from 'node:crypto';
import path from 'node:path';

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
  jwtSecret: required('WINGSBR_JWT_SECRET', 'dev-secret-nao-usar-em-producao'),
  jwtIssuer: env.WINGSBR_JWT_ISSUER ?? 'wingsbr',
  requireMfa: env.REQUIRE_MFA === 'true',
  dataKey: Buffer.from(required('DATA_KEY', crypto.createHash('sha256').update('dev-data-key').digest('hex')), 'hex'),
  crmUrl: env.WINGSBR_CRM_URL || null,
  crmSecret: env.WINGSBR_CRM_SECRET ?? '',
  waVerifyToken: env.WHATSAPP_VERIFY_TOKEN ?? 'dev-verify',
  waAppSecret: env.WHATSAPP_APP_SECRET ?? 'dev-app-secret',
  storageDir: path.resolve(env.STORAGE_DIR ?? './storage'),
  anthropicKey: env.ANTHROPIC_API_KEY || null,
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
  enableDevLogin: !isProd && env.DISABLE_DEV_LOGIN !== 'true',
};
