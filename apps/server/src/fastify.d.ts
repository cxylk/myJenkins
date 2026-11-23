import type { AuthUser } from './auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionToken: string | null;
  }
}

export {};
