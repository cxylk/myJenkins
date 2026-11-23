import fs from 'node:fs';
import path from 'node:path';

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: Array<string | null | undefined>) {
    this.secrets = [...new Set(secrets.filter((value): value is string => Boolean(value && value.length >= 4)))].sort(
      (a, b) => b.length - a.length,
    );
  }

  redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      if (!secret) continue;
      result = result.split(secret).join('***');
    }
    return result;
  }
}

function timestamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

export class BuildLog {
  private stream: fs.WriteStream | null;
  private bytes = 0;
  private truncated = false;
  private broken = false;
  readonly filePath: string;

  constructor(
    filePath: string,
    private readonly maxBytes: number,
    private readonly redactor: Redactor,
  ) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    // 磁盘满/权限变化时避免未监听的 error 事件导致整个服务退出
    stream.on('error', () => {
      this.broken = true;
    });
    this.stream = stream;
  }

  get size(): number {
    return this.bytes;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  get isBroken(): boolean {
    return this.broken;
  }

  write(text: string): void {
    if (!this.stream || this.broken || this.truncated) return;
    const safe = this.redactor.redact(text);
    const length = Buffer.byteLength(safe, 'utf8');
    if (this.bytes + length > this.maxBytes) {
      const notice = `\n[日志已超过 ${(this.maxBytes / 1024 / 1024).toFixed(0)}MB 上限，后续输出不再记录]\n`;
      this.stream.write(notice);
      this.bytes += Buffer.byteLength(notice, 'utf8');
      this.truncated = true;
      return;
    }
    this.bytes += length;
    this.stream.write(safe);
  }

  line(text: string): void {
    this.write(`[${timestamp()}] ${text}\n`);
  }

  blank(): void {
    this.write('\n');
  }

  header(title: string): void {
    this.write(`\n[${timestamp()}] ========== ${title} ==========\n`);
  }

  step(index: number, total: number, title: string): void {
    this.write(`\n[${timestamp()}] ===== [${index}/${total}] ${title} =====\n`);
  }

  info(text: string): void {
    this.line(text);
  }

  command(command: string): void {
    this.line(`  $ ${command}`);
  }

  stdout(text: string): void {
    this.write(text);
  }

  stderr(text: string): void {
    this.write(text);
  }

  error(message: string): void {
    this.line(`[错误] ${message}`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      const stream = this.stream;
      this.stream = null;
      if (!stream || this.broken) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 3000);
      stream.once('error', finish);
      stream.once('close', finish);
      try {
        stream.end(finish);
      } catch {
        finish();
      }
    });
  }
}

export interface LogChunk {
  content: string;
  offset: number;
  nextOffset: number;
  size: number;
}

export async function readLog(
  buildId: number,
  offset: number,
  limit: number,
  logDir: string,
): Promise<LogChunk> {
  const filePath = path.join(logDir, `${buildId}.log`);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return { content: '', offset, nextOffset: offset, size: 0 };
  }
  const size = stat.size;
  const start = Math.max(0, Math.min(offset, size));
  const end = Math.min(size, start + limit);
  if (end <= start) return { content: '', offset: start, nextOffset: start, size };
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      offset: start,
      nextOffset: start + bytesRead,
      size,
    };
  } finally {
    await handle.close();
  }
}

function completeUtf8Length(buffer: Buffer): number {
  let index = buffer.length - 1;
  let continuation = 0;
  while (index >= 0 && (buffer[index] & 0xc0) === 0x80) {
    continuation += 1;
    index -= 1;
  }
  if (index < 0) return buffer.length;
  const lead = buffer[index];
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (continuation + 1 < expected) return index;
  return buffer.length;
}

/** Read newly appended complete text, aligned to a line boundary when possible. */
export async function readNewLog(
  filePath: string,
  offset: number,
  maxBytes = 256 * 1024,
): Promise<{ text: string; nextOffset: number; size: number }> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return { text: '', nextOffset: offset, size: 0 };
  }
  const size = stat.size;
  if (size <= offset) return { text: '', nextOffset: offset, size };

  const length = Math.min(maxBytes, size - offset);
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const data = buffer.subarray(0, bytesRead);
    const newline = data.lastIndexOf(0x0a);
    if (newline >= 0) {
      return {
        text: data.subarray(0, newline + 1).toString('utf8'),
        nextOffset: offset + newline + 1,
        size,
      };
    }
    const complete = completeUtf8Length(data);
    if (complete <= 0) return { text: '', nextOffset: offset, size };
    return {
      text: data.subarray(0, complete).toString('utf8'),
      nextOffset: offset + complete,
      size,
    };
  } finally {
    await handle.close();
  }
}
