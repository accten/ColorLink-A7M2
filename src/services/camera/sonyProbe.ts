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
  /** 可选：随命令下发的数据（hex 字符串） */
  dataHex?: string;
}

export const PROBE_PRESETS: ProbePreset[] = [
  {
    id: 'half-press',
    label: '半按快门 0xD2C1 = 2',
    op: 0x9207,
    params: [0xd2c1],
    dataHex: '0200',
    hint: '取图前必须先半按：机身要先进"拍摄中"状态才会把照片放进内存缓存',
  },
  {
    id: 'ext-info',
    label: '扩展清单 0x9202 (0x12C,1)',
    op: 0x9202,
    params: [0x12c, 1],
    hint: '机身真正支持的操作/事件/属性清单；联机时已自动请求，这里可手动复核',
  },
  {
    id: 'all-props',
    label: '全部属性 0x9209',
    op: 0x9209,
    params: [],
    hint: '唯一可用的属性通道：D215/D213 都藏在这份属性数组里（A7M2 约 1118 字节）',
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

export async function probeVendorOp(op: number, params: number[], dataHex?: string): Promise<ProbeResult> {
  const probe = SonyCamera?.probeVendorOp;
  if (!probe) {
    return { ok: false, op, error: '当前原生模块没有 probeVendorOp（需要重新构建 APK）' };
  }
  try {
    const raw = (await probe(op, params, dataHex)) as Record<string, unknown>;
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

/**
 * 一键探测序列：每条之前由调用方先重连（A7M2 遇到不支持的操作会把管线打断）。
 * 顺序按"最可能先挂"的放后面：先试 MTP 切换，再试句柄信息/缩略图/取对象。
 */
export const PROBE_SEQUENCE: ProbePreset[] = [
  { id: 'seq-mtp', label: '切 MTP 0x9212', op: 0x9212, params: [1], hint: 'PTP↔MTP 切换' },
  { id: 'seq-info', label: '句柄信息 0x923C', op: 0x923c, params: [1, 0], hint: '[cardId, handle]' },
  { id: 'seq-thumb', label: '缩略图 0x923E', op: 0x923e, params: [1, 0], hint: '[cardAndFileType, handle]' },
  { id: 'seq-object', label: '取对象 0x923D', op: 0x923d, params: [1, 0, 0, 0x1000], hint: '[cardId, handle, offset, size]' },
];

/**
 * 回传目标（CaptureDestination / StillImageStoreDestination）：
 *
 * 参考实现里 `SonyCaptureDestination = 0xD222`，与 `SonyStillImageStoreDestination` 同值。
 * 桌面端 Imaging Edge 的"拍完自动下传到电脑"就是先把这个属性指到 host，再从虚拟句柄取图。
 * 取值猜测：0 = 只存卡，1 = 存到 host，2 = 两者都要。
 */
export const CAPTURE_DESTINATION_PROBES: ProbePreset[] = [
  { id: 'dest-host', label: '回传目标 0xD222 = 1（host）', op: 0x9205, params: [0xd222], dataHex: '0100', hint: '写属性；成功后再拍一张，看 0xFFFFC001 是否回数据' },
  { id: 'dest-both', label: '回传目标 0xD222 = 2（both）', op: 0x9205, params: [0xd222], dataHex: '0200', hint: '若 1 无效再试 2' },
  { id: 'dest-card', label: '回传目标 0xD222 = 0（只存卡）', op: 0x9205, params: [0xd222], dataHex: '0000', hint: '恢复默认' },
  // 属性描述里这台机身的枚举值是 [1, 17, 16]，默认 17。libgphoto2 从不写它，
  // 说明默认值就能拿到内存对象；但如果我们之前写过 0/1/2（2 是非法值），就得写回去。
  { id: 'dest-17', label: '回传目标 0xD222 = 17（默认）', op: 0x9205, params: [0xd222], dataHex: '1100', hint: '出厂默认值，写回去最安全' },
  { id: 'dest-16', label: '回传目标 0xD222 = 16', op: 0x9205, params: [0xd222], dataHex: '1000', hint: '另一个合法枚举值' },
];
/**
 * 取图句柄实验。
 *
 * 现场证据：按完快门后相机推 `ObjectAdded 0xC201 params=0xFFFFC001`，
 * 但 `0x1009 GetObject(0xFFFFC001)` 回的是 `code=0x2001 bytes=0`（成功但没数据）。
 * 大对象在 Sony 机身上通常要走分块读（0x101B）或厂商的 0x923D，这里把几种都列出来试。
 */
export const CAPTURE_HANDLE_PROBES: ProbePreset[] = [
  {
    id: 'partial-captured',
    label: '分块读回传 0x101B (64KB)',
    op: 0x101b,
    params: [0xffffc001, 0, 0x40000],
    hint: '参数 [handle, offset, size]；若 bytes>0 就是我们要的分块通道',
  },
  {
    id: 'partial-captured-4k',
    label: '分块读回传 0x101B (4KB)',
    op: 0x101b,
    params: [0xffffc001, 0, 0x1000],
    hint: '小窗口再试一次，排除 size 过大被拒',
  },
  {
    id: 'sony-partial',
    label: 'Sony 分块 0x923D (handle 在前)',
    op: 0x923d,
    params: [0xffffc001, 0, 0x40000, 1],
    hint: '参数顺序取自 SonyGetPartialObjectCommand(objHandle, offset, totalSize, cardInfo)',
  },
  {
    id: 'sony-partial-card0',
    label: 'Sony 分块 0x923D (cardInfo=0)',
    op: 0x923d,
    params: [0xffffc001, 0, 0x40000, 0],
    hint: '同上，cardInfo 用 0 再试一次',
  },
  {
    id: 'info-captured',
    label: '对象信息 0x1008',
    op: 0x1008,
    params: [0xffffc001],
    hint: '先把 ObjectInfo 拉出来；之前没设回传目标时这条会挂，现在值得再试',
  },
  {
    id: 'get-captured',
    label: '整读回传 0x1009',
    op: 0x1009,
    params: [0xffffc001],
    hint: '对照：已知回 0x2001 + 0 bytes',
  },
];