/**
 * 事件日志（纯逻辑）。
 *
 * FR-10 的硬要求：日志里不能出现 API Key，也不能出现完整图像数据。
 * 所以这里做了两件事：
 *  1. 写入前统一走 redact()：key/secret/token 一律替换，长 base64 截断；
 *  2. 只保留固定容量的环形缓冲，导出为纯文本。
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  event: string;
  data?: Record<string, unknown>;
}

const SECRET_KEYS = /(key|token|secret|authorization|password)/i;
const LONG_BASE64 = /^[A-Za-z0-9+/=]{200,}$/;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') {
    if (LONG_BASE64.test(value)) return `[base64 ${value.length} chars]`;
    if (/^sk-[A-Za-z0-9_-]{8,}/.test(value)) return 'sk-***';
    if (value.length > 300) return `${value.slice(0, 300)}…`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class EventLog {
  private entries: LogEntry[] = [];

  constructor(private readonly capacity = 400) {}

  append(level: LogLevel, event: string, data?: Record<string, unknown>): LogEntry {
    const entry: LogEntry = {
      at: Date.now(),
      level,
      event,
      data: data ? (redact(data) as Record<string, unknown>) : undefined,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);

    // 同时打到控制台：`adb logcat -s ReactNativeJS` 就能看到，
    // 排查真机问题不必再依赖 App 内的日志面板。
    const line = `[ColorLink] ${event}`;
    const payload = entry.data ?? '';
    if (level === 'error') console.error(line, payload);
    else if (level === 'warn') console.warn(line, payload);
    else console.log(line, payload);

    return entry;
  }

  info(event: string, data?: Record<string, unknown>) {
    return this.append('info', event, data);
  }

  warn(event: string, data?: Record<string, unknown>) {
    return this.append('warn', event, data);
  }

  error(event: string, data?: Record<string, unknown>) {
    return this.append('error', event, data);
  }

  list(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  toText(): string {
    const header = `ColorLink 事件日志 · ${this.entries.length} 条\n${'='.repeat(52)}\n`;
    const body = this.entries
      .map((e) => {
        const time = new Date(e.at).toISOString();
        const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
        return `${time} [${e.level.toUpperCase().padEnd(5)}] ${e.event}${data}`;
      })
      .join('\n');
    return `${header}${body}\n`;
  }
}

export const eventLog = new EventLog();
