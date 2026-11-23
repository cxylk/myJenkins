import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server, utils } from 'ssh2';
import type { AddressInfo } from 'node:net';
import { connectSsh, execRemote } from '../src/ssh.js';
import { CancelledError } from '../src/lib/errors.js';

let sshServer: Server;
let port = 0;
const hostKeys = utils.generateKeyPairSync('ed25519');

beforeAll(async () => {
  sshServer = new Server({ hostKeys: [hostKeys.private] }, (client) => {
    client.on('error', () => {
      /* expected when the client aborts during handshake */
    });
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === 'deploy' && context.password === 'pass-123') {
        context.accept();
      } else {
        context.reject(['password']);
      }
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`exec:${info.command}`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
  port = (sshServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => sshServer.close(() => resolve()));
});

function target(overrides: Record<string, unknown> = {}) {
  return {
    host: '127.0.0.1',
    port,
    username: 'deploy',
    authType: 'password' as const,
    secret: 'pass-123',
    ...overrides,
  };
}

describe('SSH 连接与远程执行', () => {
  it('首次连接可获取主机指纹并执行命令', async () => {
    const connected = await connectSsh(target(), { acceptAnyHostKey: true });
    try {
      expect(connected.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
      let stdout = '';
      const result = await execRemote(connected.client, 'echo hi', {
        timeoutMs: 5000,
        onStdout: (chunk) => {
          stdout += chunk;
        },
      });
      expect(result.code).toBe(0);
      expect(stdout).toBe('exec:echo hi');
    } finally {
      connected.client.end();
    }
  });

  it('未信任指纹时拒绝连接', async () => {
    await expect(connectSsh(target())).rejects.toMatchObject({ code: 'HOST_KEY_UNTRUSTED' });
  });

  it('指纹不匹配时拒绝连接', async () => {
    await expect(
      connectSsh({ ...target(), fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, {}),
    ).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
  });

  it('密码错误时返回认证失败', async () => {
    await expect(
      connectSsh({ ...target(), secret: 'wrong-password' }, { acceptAnyHostKey: true }),
    ).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
  });

  it('已取消的信号不会发起连接', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(connectSsh(target(), { acceptAnyHostKey: true, signal: controller.signal })).rejects.toBeInstanceOf(
      CancelledError,
    );
  });
});
