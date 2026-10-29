/**
 * DeepSeek 调色适配（纯逻辑：拼请求、解析响应、做严格校验）。
 *
 * 事实依据（api-docs.deepseek.com，2026-10）：
 *  - `deepseek-flash` = DeepSeek-V4.1-Flash-1017，支持 Vision 与 JSON Output
 *  - JSON Output 必须把 response_format 设为 json_object，且 prompt 里出现 "json" 与示例
 *  - 图片走 OpenAI 兼容的 image_url + data URL；服务端会缩到约 1300×1300、每图 ≤1024 tokens
 *  - 图片只能出现在 user 消息里
 */

import { EditParams, PARAM_KEYS, normalizeParams } from './params';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-flash';

export const GRADE_SYSTEM_PROMPT = `你是专业照片调色助手。你的唯一输出是一个 JSON 对象，用于驱动一个本地调色引擎。
禁止输出任何解释、markdown、代码块、图片描述或额外文本。

JSON 字段与取值范围（越界值会被裁剪，缺失字段按默认值处理）：
{
  "brightness":  -100..100,   // 亮度
  "contrast":    -100..100,   // 对比度
  "saturation":  -100..100,   // 饱和度
  "vibrance":    -100..100,   // 自然饱和度（优先作用于低饱和区）
  "hue":         -180..180,   // 整体色相旋转（度）
  "temperature": -100..100,   // 色温，正=暖
  "tint":        -100..100,   // 色调，正=偏洋红
  "highlights":  -100..100,   // 高光
  "shadows":     -100..100,   // 阴影
  "whites":      -100..100,   // 白场端点
  "blacks":      -100..100,   // 黑场端点
  "fade":           0..100,   // 褪色/哑光（抬黑位）
  "dehaze":      -100..100,   // 去雾（正=去灰、负=加雾）
  "splitShadowHue":     0..360, // 阴影染色色相角
  "splitShadowSat":     0..100, // 阴影染色浓度
  "splitHighlightHue":  0..360, // 高光染色色相角
  "splitHighlightSat":  0..100, // 高光染色浓度
  "sharpen":        0..100,   // 锐化
  "clarity":        0..100,   // 清晰度
  "noiseReduction": 0..100,   // 降噪
  "grain":          0..100,   // 颗粒
  "vignette":       0..100,   // 暗角
  "lutStrength":    0..100    // LUT 浓度
}
注意：HSL 八色带与色调曲线留给用户手动微调，你不要输出这些字段。

输出示例（必须是合法 json）：
{"brightness":4,"contrast":10,"saturation":-8,"vibrance":6,"hue":0,"temperature":12,"tint":2,"highlights":-14,"shadows":10,"whites":4,"blacks":-2,"fade":6,"dehaze":0,"splitShadowHue":210,"splitShadowSat":12,"splitHighlightHue":40,"splitHighlightSat":10,"sharpen":4,"clarity":6,"noiseReduction":0,"grain":14,"vignette":8,"lutStrength":100}

规则：
1. 结合画面实际内容与用户意图给出整体协调的参数，不要把每个字段都拉满。
2. 用户说"胶片/电影感"时，可以提高 grain(8~20)、fade(8~20) 与 vignette(5~15)、压低 highlights、略降 saturation。
3. 用户给的是增量指令（例如"再暖一点""天空更蓝"）时，在 currentParams 基础上做小幅调整，通常 ±5~20。
4. currentParams 是当前已生效的参数；除非用户明确要求重置，不要无故清零。
5. 只输出一个 json 对象，字段名与上面完全一致。`;

export interface GradeHistoryItem {
  instruction: string;
  params: EditParams;
}

export interface BuildRequestOptions {
  instruction: string;
  currentParams: EditParams;
  imageDataUrl: string;
  history?: GradeHistoryItem[];
  detail?: 'low' | 'high' | 'original' | 'auto';
  model?: string;
  /** 供应商是否支持 response_format=json_object（默认支持；不支持的会在客户端自动降级） */
  jsonMode?: boolean;
}

export function buildUserText(opts: Pick<BuildRequestOptions, 'instruction' | 'currentParams' | 'history'>): string {
  const compact = JSON.stringify(opts.currentParams);
  const history = (opts.history ?? [])
    .slice(-3)
    .map((h, i) => `${i + 1}. 指令：${h.instruction}`)
    .join('\n');

  return [
    `用户指令：${opts.instruction}`,
    `当前参数（currentParams）：${compact}`,
    history ? `最近的调整历史：\n${history}` : '',
    '请基于画面内容与当前参数，输出新的完整参数 json 对象。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 组装 OpenAI 兼容请求体。key 由调用方放进认证头（不进日志）。 */
export function buildGradeRequestBody(opts: BuildRequestOptions): Record<string, unknown> {
  return {
    model: opts.model ?? DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: GRADE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserText(opts) },
          { type: 'image_url', image_url: { url: opts.imageDataUrl, detail: opts.detail ?? 'high' } },
        ],
      },
    ],
    // 不支持 json_object 的供应商会直接 400，客户端收到后去掉这个字段重试
    ...(opts.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
    temperature: 0.2,
    max_tokens: 700,
    stream: false,
  };
}

/** 去掉模型可能加的 ```json 围栏或前后废话，尽量抠出第一个完整 JSON 对象。 */
export function extractJsonObject(text: string | null | undefined): string | null {
  if (!text) return null;
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) body = fence[1].trim();

  const start = body.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

export interface ParsedGrade {
  ok: boolean;
  params?: EditParams;
  warnings: string[];
  reason?: string;
}

/**
 * 解析模型输出。失败原因要能直接展示给用户（不是 "解析失败" 四个字）。
 */
export function parseGradeContent(content: string | null | undefined): ParsedGrade {
  if (!content || !content.trim()) {
    return { ok: false, warnings: [], reason: '模型返回了空内容，请重试' };
  }

  const json = extractJsonObject(content);
  if (!json) {
    return { ok: false, warnings: [], reason: '模型输出里没有 JSON 对象' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, warnings: [], reason: `JSON 解析失败：${detail}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, warnings: [], reason: 'JSON 顶层不是对象' };
  }

  const { params, warnings } = normalizeParams(parsed as Record<string, unknown>);
  const numericKeys = Object.keys(parsed as Record<string, unknown>).filter((k) =>
    PARAM_KEYS.includes(k as (typeof PARAM_KEYS)[number]),
  );
  if (!numericKeys.length) {
    return { ok: false, warnings, reason: '返回的 JSON 里没有任何已知调色字段' };
  }

  return { ok: true, params, warnings };
}

/** 全 0 视为"模型没理解"，用于 FR-06 的无效结果提示（重置指令除外）。 */
export function looksLikeNoop(params: EditParams, instruction: string): boolean {
  const wantsReset = /重置|清零|原图|reset|原始/.test(instruction);
  if (wantsReset) return false;
  return Object.entries(params).every(([key, value]) =>
    key === 'lutStrength' ? value === 100 : value === 0,
  );
}

/** 请求体积守门：base64 后超过该值就降采样再发，避免 48MiB 上限与慢网。 */
export const MAX_DATA_URL_BYTES = 8 * 1024 * 1024;

export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((payload.length * 3) / 4);
}
