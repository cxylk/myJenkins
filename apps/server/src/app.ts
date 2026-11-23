import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AppError, notFound } from './lib/errors.js';
import { registerAuthHook } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { userRoutes } from './routes/users.js';
import { credentialRoutes } from './routes/credentials.js';
import { serverRoutes } from './routes/servers.js';
import { projectRoutes } from './routes/projects.js';
import { buildRoutes } from './routes/builds.js';
import { systemRoutes } from './routes/system.js';

export async function buildApp(options: { logger?: boolean; serveStatic?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: config.trustProxy,
    bodyLimit: 4 * 1024 * 1024,
  });

  await app.register(cookie);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({
        code: error.code,
        message: error.message,
        details: error.details,
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: error.issues.map((issue) => `${issue.path.join('.') || '参数'}：${issue.message}`).join('；'),
        details: error.issues,
      });
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' });
    }
    req.log.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误，请查看服务日志' });
  });

  registerAuthHook(app);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(credentialRoutes, { prefix: '/api/credentials' });
  await app.register(serverRoutes, { prefix: '/api/servers' });
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(buildRoutes, { prefix: '/api' });
  await app.register(systemRoutes, { prefix: '/api' });

  if (options.serveStatic !== false && fs.existsSync(config.webDist)) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: config.webDist,
      serve: false,
      index: false,
      cacheControl: true,
      maxAge: '1h',
    });

    app.get('/*', async (req, reply) => {
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      if (pathname.startsWith('/api/')) throw notFound('接口不存在');
      if (pathname.includes('\0') || pathname.includes('..')) throw notFound();
      const relative = pathname.replace(/^\/+/, '');
      const candidate = path.join(config.webDist, relative);
      if (relative && candidate.startsWith(config.webDist) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        if (relative.startsWith('assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        return reply.sendFile(relative);
      }
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      name: 'myJenkins API',
      message: '前端尚未构建。开发模式请访问 Vite 端口，或先执行 pnpm build。',
    }));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' });
      }
      return reply.code(404).send({ code: 'NOT_FOUND', message: '页面不存在（前端未构建）' });
    });
  }

  return app;
}
