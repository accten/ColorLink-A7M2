/**
 * 编辑会话（纯逻辑）。
 *
 * 一次编辑 = 参数 + 曲线 + 预设/LUT 引用。把它放在 core 里而不是 store 里，
 * 是为了让持久化（sessionStore）、批量操作、撤销/重做共用同一套归一化规则，
 * 也避免 store ↔ 持久化之间循环 import。
 */

import {
  CurveSet,
  cloneCurveSet,
  curveSetEquals,
  defaultCurveSet,
  isIdentityCurveSet,
  normalizeCurveSet,
} from './curve';
import { DEFAULT_PARAMS, EditParams, describeParams, isNeutral, normalizeParams } from './params';

export interface EditorSession {
  params: EditParams;
  curves: CurveSet;
  presetId: string | null;
  lutPath: string | null;
  lutName: string | null;
}

export function defaultEditorSession(): EditorSession {
  return {
    params: { ...DEFAULT_PARAMS },
    curves: defaultCurveSet(),
    presetId: 'original',
    lutPath: null,
    lutName: null,
  };
}

/** 外部输入（持久化文件 / 剪贴板 / 撤销栈）的安全网。 */
export function normalizeSession(input: unknown): EditorSession {
  const fallback = defaultEditorSession();
  if (!input || typeof input !== 'object') return fallback;
  const record = input as Record<string, unknown>;

  const { params } = normalizeParams(record.params as Partial<EditParams> | null, {
    keepMissingDefaults: true,
  });

  return {
    params,
    curves: normalizeCurveSet(record.curves),
    presetId: typeof record.presetId === 'string' ? record.presetId : null,
    lutPath: typeof record.lutPath === 'string' && record.lutPath ? record.lutPath : null,
    lutName: typeof record.lutName === 'string' && record.lutName ? record.lutName : null,
  };
}

/** 这张图"没动过"：参数全默认、曲线恒等、也没有套 LUT。 */
export function isSessionNeutral(session: EditorSession): boolean {
  return isNeutral(session.params) && isIdentityCurveSet(session.curves) && !session.lutPath;
}

export function sessionEquals(a: EditorSession, b: EditorSession): boolean {
  if (a.lutPath !== b.lutPath) return false;
  if (a.lutName !== b.lutName) return false;
  if (a.presetId !== b.presetId) return false;
  if (!curveSetEquals(a.curves, b.curves)) return false;
  return Object.keys(DEFAULT_PARAMS).every((key) => {
    const k = key as keyof EditParams;
    return a.params[k] === b.params[k];
  });
}

export function cloneSession(session: EditorSession): EditorSession {
  return {
    params: { ...session.params },
    curves: cloneCurveSet(session.curves),
    presetId: session.presetId,
    lutPath: session.lutPath,
    lutName: session.lutName,
  };
}

/** 图库/首页的一句话摘要：参数优先，其次曲线，最后 LUT。 */
export function describeSession(session: EditorSession): string {
  const params = describeParams(session.params);
  if (params !== '原图') return params;
  if (!isIdentityCurveSet(session.curves)) return '曲线';
  if (session.lutPath) return session.lutName ? `LUT ${session.lutName}` : 'LUT';
  return '原图';
}

/** 只把「调色」部分拷出来（批量粘贴 / 复制调色用）。 */
export function gradeOf(session: EditorSession): Pick<EditorSession, 'params' | 'curves' | 'lutPath' | 'lutName'> {
  return {
    params: { ...session.params },
    curves: cloneCurveSet(session.curves),
    lutPath: session.lutPath,
    lutName: session.lutName,
  };
}
