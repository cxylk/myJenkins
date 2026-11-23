import { describe, expect, it } from 'vitest';
import { SecretBox, hashPassword, randomToken, sha256, verifyPassword } from '../src/lib/crypto.js';

describe('密码哈希', () => {
  it('能够校验正确密码并拒绝错误密码', async () => {
    const hash = await hashPassword('S3cret-pass!');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('S3cret-pass!', hash)).toBe(true);
    expect(await verifyPassword('wrong-pass', hash)).toBe(false);
  });

  it('相同密码每次生成不同盐值', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('拒绝格式错误的哈希', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$2$3$4')).toBe(false);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 7));

  it('加密后可解密，且每次密文不同', () => {
    const first = box.encrypt('token-abc-123');
    const second = box.encrypt('token-abc-123');
    expect(first).not.toBe(second);
    expect(first.startsWith('v1:')).toBe(true);
    expect(box.decrypt(first)).toBe('token-abc-123');
    expect(box.decrypt(second)).toBe('token-abc-123');
  });

  it('支持中文与多行私钥内容', () => {
    const value = '第一行\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
    expect(box.decrypt(box.encrypt(value))).toBe(value);
  });

  it('篡改密文会失败', () => {
    const payload = box.encrypt('sensitive');
    const parts = payload.split(':');
    const data = Buffer.from(parts[3], 'base64');
    data[0] ^= 0xff;
    parts[3] = data.toString('base64');
    expect(() => box.decrypt(parts.join(':'))).toThrow();
  });

  it('使用错误密钥无法解密', () => {
    const other = new SecretBox(Buffer.alloc(32, 9));
    expect(() => other.decrypt(box.encrypt('hello'))).toThrow();
  });
});

describe('随机工具', () => {
  it('token 足够长且 sha256 稳定', () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(sha256(token)).toHaveLength(64);
    expect(sha256(token)).toBe(sha256(token));
  });
});
