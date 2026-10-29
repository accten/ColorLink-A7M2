import {
  GradeHistoryItem,
  MAX_DATA_URL_BYTES,
  buildGradeRequestBody,
  estimateDataUrlBytes,
  looksLikeNoop,
  parseGradeContent,
} from '@/core/ai';
import { AiConfig } from '@/core/aiProvider';
import { EditParams } from '@/core/params';
import { eventLog } from '@/core/log';

import { readDataUrl, uriToMime } from './ingest';

const TIMEOUT_MS = 25_000;
const PROBE_TIMEOUT_MS = 12_000;
/** 首发 + JSON 模式降级 + 无效输出重试，最多 3 次 */
const MAX_ATTEMPTS = 3;

export interface GradeOutcome {
  ok: boolean;
  params?: EditParams;
  warnings: string[];
  reason?: string;
  latencyMs: number;
  attempts: number;
}

export interface GradeOptions {
  /** 供应商配置（地址 / 模型 / 认证方式），由 effectiveAiConfig 合成 */
  config: AiConfig;
  /** 该供应商的 Key；本地模型可以为 null */
  apiKey: string | null;
  imageUri: string;
  instruction: string;
  currentParams: EditParams;
  history?: GradeHistoryItem[];
}

function authHeaders(config: AiConfig, apiKey: string | null, json = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (!apiKey) return headers;
  if (config.auth === 'api-key') headers['api-key'] = apiKey;
  else headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** HTTP 状态 → 用户能看懂的原因（含下一步动作）。 */
export function describeHttpError(status: number, text: string, config: AiConfig): string {
  const detail = text ? `：${text.slice(0, 160)}` : '';
  switch (status) {
    case 400:
      return `请求被拒绝（400）${detail}`;
    case 401:
      return 'API Key 无效或已过期（401），请到设置里重新填写';
    case 402:
      return '账户余额不足（402）';
    case 403:
      return '无权访问该模型（403），检查 Key 的权限或模型是否开通';
    case 404:
      return `接口地址或模型不存在（404）${detail}。检查设置里的请求地址（常见是少了或多了 /v1）与模型名`;
    case 422:
      return `参数不被接受（422）${detail}`;
    case 429:
      return '请求过于频繁（429），请稍后重试';
    default:
      return status >= 500
        ? `供应商服务异常（HTTP ${status}），稍后重试${detail}`
        : `请求失败（HTTP ${status}）${detail}`;
  }
}

function readContent(payload: unknown): string | null {
  const choices = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  // 少数供应商返回 [{type:'text',text:'...'}] 的分段格式
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('');
    return text || null;
  }
  return null;
}

/**
 * 调「任意 OpenAI 兼容供应商」拿调色参数。
 *
 * 失败分级（对应 FR-06 的验收）：
 *  - 配置不全 / 缺 Key → 直接返回原因，不发请求；
 *  - 网络 / HTTP 错误 → 参数不变，提示可读错误（404 会提示检查 /v1）；
 *  - 供应商不支持 response_format=json_object → 自动去掉该字段重试一次；
 *  - JSON 非法 / 全 0 → 自动重试，仍失败则返回原因；
 *  - 成功 → 返回已校验、已夹取的参数 + warnings（越界字段会列出来）。
 */
export async function requestGrade(options: GradeOptions): Promise<GradeOutcome> {
  const started = Date.now();
  const { config, apiKey } = options;

  if (config.missing) {
    return { ok: false, warnings: [], reason: `AI 未配置：${config.missing}（设置 → AI 调色）`, latencyMs: 0, attempts: 0 };
  }
  if (config.requiresKey && !apiKey) {
    return {
      ok: false,
      warnings: [],
      reason: `未配置 ${config.providerName} 的 API Key，请到设置里填写`,
      latencyMs: 0,
      attempts: 0,
    };
  }

  let imageDataUrl: string;
  try {
    imageDataUrl = await readDataUrl(options.imageUri, uriToMime(options.imageUri));
  } catch (error) {
    return {
      ok: false,
      warnings: [],
      reason: `读取图片失败：${error instanceof Error ? error.message : String(error)}`,
      latencyMs: Date.now() - started,
      attempts: 0,
    };
  }

  if (estimateDataUrlBytes(imageDataUrl) > MAX_DATA_URL_BYTES) {
    return {
      ok: false,
      warnings: [],
      reason: '图片太大，供应商可能拒收。请改用编辑预览图，或降低导出尺寸',
      latencyMs: Date.now() - started,
      attempts: 0,
    };
  }

  let jsonMode = config.jsonMode;
  let lastReason = '未知错误';
  let attempts = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    attempts = attempt + 1;
    const body = buildGradeRequestBody({
      instruction: options.instruction,
      currentParams: options.currentParams,
      imageDataUrl,
      history: options.history,
      detail: 'high',
      model: config.model,
      jsonMode,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(config.chatUrl, {
        method: 'POST',
        headers: authHeaders(config, apiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // 有些供应商不认 response_format，但会返回 400 —— 去掉它再试一次
        if (jsonMode && response.status === 400 && /response[_ ]?format|json_?object|json mode/i.test(text)) {
          jsonMode = false;
          lastReason = '该供应商不支持 JSON 模式，已自动降级重试';
          eventLog.warn('ai.grade.jsonmode.fallback', { provider: config.providerId });
          continue;
        }

        lastReason = describeHttpError(response.status, text, config);
        eventLog.warn('ai.grade.http', { status: response.status, attempt: attempts, provider: config.providerId });
        if (response.status === 429 || response.status >= 500) continue;
        break;
      }

      const payload = (await response.json()) as unknown;
      const parsed = parseGradeContent(readContent(payload));

      if (parsed.ok && parsed.params) {
        if (looksLikeNoop(parsed.params, options.instruction)) {
          lastReason = '模型给出的参数与当前一致，可能没理解你的意图，换个说法再试';
          continue;
        }
        const latencyMs = Date.now() - started;
        eventLog.info('ai.grade.ok', {
          provider: config.providerId,
          model: config.model,
          instruction: options.instruction.slice(0, 40),
          latencyMs,
          attempts,
          warnings: parsed.warnings.length,
        });
        return { ok: true, params: parsed.params, warnings: parsed.warnings, latencyMs, attempts };
      }

      lastReason = parsed.reason ?? '模型返回无效参数';
      eventLog.warn('ai.grade.invalid', { attempt: attempts, reason: lastReason, provider: config.providerId });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      lastReason = aborted
        ? `请求超时（${Math.round(TIMEOUT_MS / 1000)}s），请检查网络或换更快的模型`
        : `网络错误：${error instanceof Error ? error.message : String(error)}`;
      eventLog.warn('ai.grade.network', { attempt: attempts, reason: lastReason });
    } finally {
      clearTimeout(timer);
    }
  }

  eventLog.error('ai.grade.failed', { reason: lastReason, attempts, provider: config.providerId });
  return { ok: false, warnings: [], reason: lastReason, latencyMs: Date.now() - started, attempts };
}

export interface AiProbeResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

/**
 * 测试连接：先试 GET /models（不花钱），失败再发一条 1 token 的短文请求。
 * 这样既能验证地址/Key，也能验证模型名与 JSON 之外的基本通路。
 */
export async function probeAiConnection(config: AiConfig, apiKey: string | null): Promise<AiProbeResult> {
  const started = Date.now();
  if (config.missing) return { ok: false, message: config.missing, latencyMs: 0 };
  if (config.requiresKey && !apiKey) {
    return { ok: false, message: `未填写 ${config.providerName} 的 API Key`, latencyMs: 0 };
  }

  // Azure 的 /models 不适用（地址里带 deployment），直接发最小请求
  if (config.auth !== 'api-key' && config.modelsUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(config.modelsUrl, {
        method: 'GET',
        headers: authHeaders(config, apiKey, false),
        signal: controller.signal,
      });
      if (response.ok) {
        const payload = (await response.json().catch(() => null)) as { data?: unknown[] } | null;
        const count = Array.isArray(payload?.data) ? payload!.data!.length : 0;
        eventLog.info('ai.probe.models', { provider: config.providerId, count });
        return {
          ok: true,
          message: count
            ? `${config.providerName} 连接正常 · 可见 ${count} 个模型`
            : `${config.providerName} 连接正常`,
          latencyMs: Date.now() - started,
        };
      }
      // 401/403 是确定的失败；404/405 说明不支持 /models，继续用 chat 探测
      if (response.status === 401 || response.status === 403) {
        const text = await response.text().catch(() => '');
        return { ok: false, message: describeHttpError(response.status, text, config), latencyMs: Date.now() - started };
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        message: aborted ? '连接超时，检查网络或请求地址' : `网络错误：${error instanceof Error ? error.message : String(error)}`,
        latencyMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(config.chatUrl, {
      method: 'POST',
      headers: authHeaders(config, apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      eventLog.warn('ai.probe.failed', { status: response.status, provider: config.providerId });
      return {
        ok: false,
        message: describeHttpError(response.status, text, config),
        latencyMs: Date.now() - started,
      };
    }

    await response.json().catch(() => null);
    eventLog.info('ai.probe.ok', { provider: config.providerId, model: config.model });
    return {
      ok: true,
      message: `${config.providerName} 连接正常 · ${config.model} 已响应`,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      message: aborted ? '连接超时，检查网络或请求地址' : `网络错误：${error instanceof Error ? error.message : String(error)}`,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
