import type { NextFunction, Request, Response } from 'express';

type Level = 'info' | 'warn' | 'error';

/** Uma linha JSON por evento (lida por `docker compose logs app` e por scripts/ver-erros.sh). */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line); else console.log(line);
}

const MUTATION = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Rotas de alto volume ou sem interesse para suporte: só aparecem se derem erro.
const QUIET = [/^\/api\/public\/(map|meta|opportunities)(\/|$)/, /^\/api\/auth\/session$/];

/**
 * Registra toda alteração (POST/PUT/PATCH/DELETE) e toda resposta com erro (4xx/5xx), com quem fez.
 * Não registra corpo da requisição (senhas, CPF) nem query string (links com token).
 */
export function requestLog(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const status = res.statusCode;
    const path = req.originalUrl.split('?')[0];
    const failed = status >= 400;
    if (!failed && (!MUTATION.has(req.method) || QUIET.some((r) => r.test(path)))) return;
    const u = req.user;
    log(status >= 500 ? 'error' : failed ? 'warn' : 'info', failed ? 'request_failed' : 'request', {
      method: req.method, path, status, ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
      user: u ? { id: u.id, name: u.name, role: u.role } : null,
      ...(res.locals.errorMessage ? { error: res.locals.errorMessage } : {}),
      ...(res.locals.errorDetails ? { details: res.locals.errorDetails } : {}),
    });
  });
  next();
}
