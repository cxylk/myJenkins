import { describe, expect, it } from 'vitest';
import { assertSafeRelativePath, safeRemoteJoin } from '../src/lib/paths.js';

describe('远程路径校验', () => {
  it('正常相对路径可以拼接', () => {
    expect(safeRemoteJoin('/opt/app', 'a/b.txt')).toBe('/opt/app/a/b.txt');
    expect(safeRemoteJoin('/opt/app/', 'a.txt')).toBe('/opt/app/a.txt');
    expect(safeRemoteJoin('/', 'a.txt')).toBe('/a.txt');
  });

  it('拒绝 .. 与空路径段', () => {
    expect(() => assertSafeRelativePath('../etc/passwd')).toThrow();
    expect(() => assertSafeRelativePath('a/../../etc/passwd')).toThrow();
    expect(() => assertSafeRelativePath('a//b')).toThrow();
    expect(() => assertSafeRelativePath('./a')).toThrow();
    expect(() => assertSafeRelativePath('')).toThrow();
    expect(() => assertSafeRelativePath('/etc/passwd')).toThrow();
    expect(() => assertSafeRelativePath('C:/windows')).toThrow();
  });

  it('反斜杠作为 POSIX 文件名字面量保留，不会被当作分隔符', () => {
    const name = 'a\\..\\..\\..\\tmp\\pwn';
    expect(safeRemoteJoin('/opt/app', name)).toBe(`/opt/app/${name}`);
    expect(assertSafeRelativePath(name)).toBe(name);
  });

  it('拼接结果不能绕过远程目录', () => {
    expect(() => safeRemoteJoin('/opt/app', 'a/../../../etc/passwd')).toThrow();
  });
});
