import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what = 'Recurso') => new HttpError(404, `${what} não encontrado`);
export const forbidden = (msg = 'Acesso negado') => new HttpError(403, msg);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    fn(req, res, next).catch(next);

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  // a mensagem fica em res.locals para o log da requisição (lib/log.ts) mostrar o motivo do erro
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    res.locals.errorMessage = 'Dados inválidos'; res.locals.errorDetails = details;
    return res.status(400).json({ error: 'Dados inválidos', details });
  }
  if (err instanceof HttpError) {
    res.locals.errorMessage = err.message; res.locals.errorDetails = err.details;
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') { res.locals.errorMessage = 'Arquivo excede o limite'; return res.status(413).json({ error: 'Arquivo excede o limite permitido' }); }
  res.locals.errorMessage = err?.message;
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'unhandled_error', path: req.originalUrl.split('?')[0], error: err?.message, stack: err?.stack }));
  res.status(500).json({ error: 'Erro interno' });
}
