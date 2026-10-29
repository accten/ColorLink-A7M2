import { EditorSession, isSessionNeutral, normalizeSession } from '@/core/session';
import { eventLog } from '@/core/log';

import { readTextSafe, sessionsFile, writeTextAtomic } from './paths';

/**
 * 编辑会话持久化（sessions.json）。
 *
 * 为什么必须有：批量编辑的前提是"编辑状态活得比一次点击更久"。没有它，
 * 给 50 张图套完预设、退出 App 再进来，所有调整都会消失。
 *
 * 写入策略：内存里立刻生效，磁盘上防抖 500ms 合并写（拖滑块不会每帧写盘）；
 * 只存"动过"的会话，避免 sessions.json 被一堆默认值撑大。
 */

interface SessionsPayload {
  version: number;
  sessions: Record<string, EditorSession>;
  savedAt: number;
}

const VERSION = 1;
const SAVE_DEBOUNCE_MS = 500;
const MAX_SESSIONS = 2000;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: Record<string, EditorSession> | null = null;
let writing = false;

function compact(sessions: Record<string, EditorSession>): Record<string, EditorSession> {
  const entries = Object.entries(sessions)
    .filter(([, session]) => !isSessionNeutral(session))
    .slice(0, MAX_SESSIONS);
  return Object.fromEntries(entries);
}

export async function loadSessions(validIds: Set<string>): Promise<Record<string, EditorSession>> {
  const raw = readTextSafe(sessionsFile);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Partial<SessionsPayload>;
    const source = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    const result: Record<string, EditorSession> = {};

    for (const [id, value] of Object.entries(source)) {
      if (!validIds.has(id)) continue; // 资产已删除 → 会话一起清掉
      if (!value || typeof value !== 'object') continue;
      const session = normalizeSession(value);
      if (isSessionNeutral(session)) continue;
      result[id] = session;
    }

    eventLog.info('sessions.loaded', { kept: Object.keys(result).length });
    return result;
  } catch (error) {
    eventLog.warn('sessions.parse.failed', { error: String(error) });
    return {};
  }
}

/** 防抖写盘：连续改参数只落一次盘。 */
export function scheduleSaveSessions(sessions: Record<string, EditorSession>): void {
  pending = sessions;
  if (timer || writing) return;
  timer = setTimeout(() => {
    timer = null;
    void flushSessions();
  }, SAVE_DEBOUNCE_MS);
}

export async function flushSessions(): Promise<void> {
  if (!pending || writing) return;
  const snapshot = pending;
  pending = null;
  writing = true;
  let failed = false;

  try {
    const payload: SessionsPayload = {
      version: VERSION,
      sessions: compact(snapshot),
      savedAt: Date.now(),
    };
    await writeTextAtomic(sessionsFile, JSON.stringify(payload));
  } catch (error) {
    failed = true;
    eventLog.error('sessions.save.failed', { error: String(error) });
    // 写失败时把数据放回去，下次改参数还会重试（不丢用户的调整，也不死循环重试）
    pending = snapshot;
  } finally {
    writing = false;
    if (!failed && pending) scheduleSaveSessions(pending);
  }
}

/** 测试与退出前用：把待写内容立刻落盘并清空定时器。 */
export async function flushSessionsNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flushSessions();
}
