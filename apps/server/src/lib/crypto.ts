import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import { paths } from '../config.js';

function scryptAsync(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * AES-256-GCM secret box. Payload format: v1:<iv b64>:<tag b64>:<cipher b64>
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('加密密钥长度必须为 32 字节');
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new AppError(500, 'SECRET_FORMAT', '密钥数据格式不正确');
    }
    try {
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const data = Buffer.from(parts[3], 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new AppError(
        500,
        'SECRET_DECRYPT',
        '无法解密已保存的密钥，请确认 APP_SECRET 没有变更，或重新填写相关凭据',
      );
    }
  }
}

export async function loadSecretBox(appSecret: string): Promise<SecretBox> {
  if (appSecret) {
    return new SecretBox(createHash('sha256').update(appSecret, 'utf8').digest());
  }
  await fs.mkdir(path.dirname(paths.masterKey), { recursive: true, mode: 0o700 });
  let raw: Buffer;
  try {
    raw = await fs.readFile(paths.masterKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new AppError(500, 'MASTER_KEY_READ', '无法读取 data/master.key，请检查文件权限后重启服务');
    }
    raw = randomBytes(32);
    try {
      await fs.writeFile(paths.masterKey, raw, { mode: 0o600, flag: 'wx' });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new AppError(500, 'MASTER_KEY_WRITE', '无法创建 data/master.key，请检查数据目录权限');
      }
      raw = await fs.readFile(paths.masterKey);
    }
  }
  if (raw.length !== 32) {
    throw new AppError(500, 'MASTER_KEY_INVALID', 'data/master.key 已损坏（长度不是 32 字节），请恢复备份的主密钥');
  }
  return new SecretBox(raw);
}
