import type { FastifyInstance, FastifyRequest } from 'fastify';
import { COOKIE_NAME, findSession } from './session.js';
import { forbidden, unauthorized } from '../lib/errors.js';

const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/health']);

export function registerAuthHook(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onRequest', async (req) => {
    const pathname = req.url.split('?')[0];
    if (!pathname.startsWith('/api/')) return;
    if (PUBLIC_ROUTES.has(pathname)) return;

    const token = req.cookies[COOKIE_NAME];
    if (token) {
      const session = findSession(token);
      if (session) {
        req.user = session.user;
        req.sessionToken = token;
      }
    }
    if (!req.user) throw unauthorized();
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (!origin) return;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw forbidden('请求来源不合法');
    }
    if (originHost !== req.headers.host) throw forbidden('跨站请求被拒绝');
  });
}

export function currentUser(req: FastifyRequest) {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: FastifyRequest) {
  const user = currentUser(req);
  if (user.role !== 'admin') throw forbidden('需要管理员权限');
  return user;
}
