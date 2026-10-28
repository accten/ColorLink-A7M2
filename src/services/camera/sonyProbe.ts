import SonyCamera from 'expo-sony-camera';

import { eventLog } from '@/core/log';

/**
 * Sony 厂商操作的诊断探针。
 *
 * 取图相关操作（0x923B 根目录句柄、0x923C 句柄信息、0x923D 取对象、0x923E 缩略/预览、
 * 0x9212 PTP↔MTP 切换）没有公开文档，参数与返回结构只能靠真机试探。
 * 这里把它们做成设置页里可点的实验，结果直接落到事件日志，方便对照解码。
 *
 * 注意：机身在遇到不支持的操作时可能不回包，会把 USB 管线打断；
 * 所以每次只点一条、看完结果再试下一条。
 */

export interface ProbeResult {
  ok: boolean;
  op: number;
  code?: number;
  bytes?: number;
  /** 返回数据前 256 字节的 hex */
  head?: string;
  ms?: number;
  error?: string;
}

export interface ProbePreset {
  id: string;
  label: string;
  op: number;
  params: number[];
  hint: string;
}

export const PROBE_PRESETS: ProbePreset[] = [
  {
    id: 'all-props',
    label: '全部属性 0x9209',
    op: 0x9209,
    params: [],
    hint: 'A7M2 会回 ~1118 字节；我们的解析器解不出属性，靠这段 hex 反推容器格式',
  },
  {
    id: 'root-handles',
    label: '根目录句柄 0x923B (card=1)',
    op: 0x923b,
    params: [1],
    hint: '参考实现里参数是 storageId>>16（0x00010000 → 1），不是完整 storageId',
  },
  {
    id: 'root-handles-full',
    label: '根目录句柄 0x923B (storageId)',
    op: 0x923b,
    params: [0x00010000],
    hint: '对照用：直接传完整 storageId 看看机身怎么回',
  },
  {
    id: 'dir-handles',
    label: '目录句柄 0x923B (1, 0)',
    op: 0x923b,
    params: [1, 0],
    hint: '参数猜测为 [cardId, dirHandle]；参考实现会递归子目录',
  },
  {
    id: 'handle-info',
    label: '句柄信息 0x923C',
    op: 0x923c,
    params: [1, 0],
    hint: '参数猜测为 [cardId, handle]；返回文件名/大小/格式',
  },
  {
    id: 'thumb',
    label: '缩略图 0x923E',
    op: 0x923e,
    params: [1, 0],
    hint: '参数猜测为 [cardAndFileType, handle]',
  },
  {
    id: 'get-object',
    label: '取对象 0x923D',
    op: 0x923d,
    params: [1, 0, 0, 0x00100000],
    hint: '参数猜测为 [cardId, handle, offset, size]',
  },
  {
    id: 'toggle-mtp',
    label: '切 MTP 0x9212',
    op: 0x9212,
    params: [1],
    hint: '参考实现用它在 PTP/MTP 间切换后读卡；失败也无副作用（会记录返回码）',
  },
];

export async function probeVendorOp(op: number, params: number[]): Promise<ProbeResult> {
  const probe = SonyCamera?.probeVendorOp;
  if (!probe) {
    return { ok: false, op, error: '当前原生模块没有 probeVendorOp（需要重新构建 APK）' };
  }
  try {
    const raw = (await probe(op, params)) as Record<string, unknown>;
    const result: ProbeResult = {
      ok: Boolean(raw.ok),
      op,
      code: typeof raw.code === 'number' ? raw.code : undefined,
      bytes: typeof raw.bytes === 'number' ? raw.bytes : undefined,
      head: typeof raw.head === 'string' ? raw.head : undefined,
      ms: typeof raw.ms === 'number' ? raw.ms : undefined,
      error: typeof raw.error === 'string' ? raw.error : undefined,
    };
    // 256 字节 = 512 个 hex 字符，一条日志装不下：分 200 字符一段写，方便从 logcat 捞全
    const head = result.head ?? '';
    eventLog.info('probe.sony', {
      op: `0x${op.toString(16).toUpperCase()}`,
      code: result.code,
      bytes: result.bytes,
      ms: result.ms,
      error: result.error,
      headLength: head.length,
    });
    // 每段 120 字符：eventLog 会把 >=200 字符的纯字母数字串当成 base64 打码
    const chunk = 120;
    for (let i = 0; i * chunk < head.length; i += 1) {
      eventLog.info('probe.sony.hex', { part: i, hex: head.slice(i * chunk, (i + 1) * chunk) });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    eventLog.error('probe.sony.failed', { op, error: message });
    return { ok: false, op, error: message };
  }
}

export function formatProbeResult(result: ProbeResult): string {
  if (!result.ok) return `失败：${result.error ?? '未知原因'}（${result.ms ?? 0}ms）`;
  const code = result.code != null ? `0x${result.code.toString(16).toUpperCase()}` : '—';
  const head = result.head ? result.head.slice(0, 1200) : '';
  return `code=${code} bytes=${result.bytes ?? 0} ms=${result.ms ?? 0}${head ? `\n${head}` : ''}`;
}
