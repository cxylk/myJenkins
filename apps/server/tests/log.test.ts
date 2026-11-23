import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BuildLog, Redactor, readNewLog } from '../src/pipeline/log.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'myj-log-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('发布日志', () => {
  it('写入、脱敏并统计大小', async () => {
    const file = path.join(dir, 'build-1.log');
    const log = new BuildLog(file, 10_000, new Redactor(['super-secret-token']));
    log.header('发布 #1');
    log.info('token=super-secret-token');
    log.stdout('输出\n');
    await log.close();

    const content = readFileSync(file, 'utf8');
    expect(content).toContain('发布 #1');
    expect(content).toContain('token=***');
    expect(content).not.toContain('super-secret-token');
    expect(log.size).toBeGreaterThan(10);
  });

  it('超过上限后截断并停止写入', async () => {
    const file = path.join(dir, 'build-2.log');
    const log = new BuildLog(file, 200, new Redactor([]));
    for (let i = 0; i < 20; i += 1) log.info(`line-${i}-${'x'.repeat(30)}`);
    await log.close();
    expect(log.isTruncated).toBe(true);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('日志已超过');
    expect(content.length).toBeLessThan(600);
  });

  it('按行增量读取，保持 UTF-8 完整', async () => {
    const file = path.join(dir, 'build-3.log');
    const log = new BuildLog(file, 10_000, new Redactor([]));
    log.info('第一行');
    log.info('第二行');
    await log.close();

    const first = await readNewLog(file, 0, 10_000);
    expect(first.text).toContain('第一行');
    expect(first.text.endsWith('\n')).toBe(true);
    expect(first.nextOffset).toBe(first.size);

    const second = await readNewLog(file, first.nextOffset, 10_000);
    expect(second.text).toBe('');
    expect(second.nextOffset).toBe(first.nextOffset);
  });

  it('没有换行时按完整字符切分', async () => {
    const file = path.join(dir, 'build-4.log');
    const log = new BuildLog(file, 10_000, new Redactor([]));
    log.write('你好');
    await log.close();

    const first = await readNewLog(file, 0, 4);
    expect(first.text).toBe('你');
    expect(first.nextOffset).toBe(3);

    const second = await readNewLog(file, first.nextOffset, 10);
    expect(second.text).toBe('好');
  });

  it('不存在的日志返回空内容', async () => {
    const result = await readNewLog(path.join(dir, 'missing.log'), 0);
    expect(result).toEqual({ text: '', nextOffset: 0, size: 0 });
  });

  it('日志目标不可写时不会崩溃且 close 能结束', async () => {
    const target = path.join(dir, 'a-directory');
    mkdirSync(target, { recursive: true });
    const log = new BuildLog(target, 1000, new Redactor([]));
    log.info('hello');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(log.isBroken).toBe(true);
    await log.close();
  });
});
