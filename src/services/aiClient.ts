import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  GradeHistoryItem,
  buildGradeRequestBody,
  looksLikeNoop,
  parseGradeContent,
} from '@/core/ai';
import { EditParams } from '@/core/params';
import { eventLog } from '@/core/log';

import { readDataUrl, uriToMime } from './ingest';

const TIMEOUT_MS = 16_000;

export interface GradeOutcome {
  ok: boolean;
  params?: EditParams;
  warnings: string[];
  reason?: string;
  latencyMs: number;
  attempts: number;
}

export interface GradeOptions {
  apiKey: string | null;
  imageUri: string;
  instruction: string;
  currentParams: EditParams;
  history?: GradeHistoryItem[];
}

/**
 * 调 DeepSeek 拿参数。
 *
 * 失败分级（对应 FR-06 的验收）：
 *  - 无 Key → 直接返回原因，不发请求；
 *  - 网络 / HTTP 错误 → 参数不变，提示可读错误；
 *  - JSON 非法 / 全 0 → 自动重试 1 次，仍失败则返回原因；
 *  - 成功 → 返回已校验、已夹取的参数 + warnings（越界字段会列出来）。
 */
export async function requestGrade(options: GradeOptions): Promise<GradeOutcome> {
  const started = Date.now();

  if (!options.apiKey) {
    return { ok: false, warnings: [], reason: '未配置 API Key，请到设置里填写', latencyMs: 0, attempts: 0 };
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

  const body = buildGradeRequestBody({
    instruction: options.instruction,
    currentParams: options.currentParams,
    imageDataUrl,
    history: options.history,
    detail: 'high',
    model: DEEPSEEK_MODEL,
  });

  let lastReason = '未知错误';
  let attempts = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts = attempt + 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        lastReason =
          response.status === 401
            ? 'API Key 无效或已过期（401）'
            : response.status === 402
              ? '账户余额不足（402）'
              : response.status === 429
                ? '请求过于频繁（429），请稍后重试'
                : `请求失败（HTTP ${response.status}）${text ? `：${text.slice(0, 120)}` : ''}`;
        eventLog.warn('ai.grade.http', { status: response.status, attempt: attempts });
        if (response.status === 429 || response.status >= 500) continue;
        break;
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string | null } }[];
      };
      const content = payload.choices?.[0]?.message?.content ?? null;
      const parsed = parseGradeContent(content);

      if (parsed.ok && parsed.params) {
        if (looksLikeNoop(parsed.params, options.instruction)) {
          lastReason = '模型给出的参数与当前一致，可能没理解你的意图，换个说法再试';
          continue;
        }
        const latencyMs = Date.now() - started;
        eventLog.info('ai.grade.ok', {
          instruction: options.instruction.slice(0, 40),
          latencyMs,
          attempts,
          warnings: parsed.warnings.length,
        });
        return { ok: true, params: parsed.params, warnings: parsed.warnings, latencyMs, attempts };
      }

      lastReason = parsed.reason ?? '模型返回无效参数';
      eventLog.warn('ai.grade.invalid', { attempt: attempts, reason: lastReason });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      lastReason = aborted ? '请求超时（16s），请检查网络' : `网络错误：${error instanceof Error ? error.message : String(error)}`;
      eventLog.warn('ai.grade.network', { attempt: attempts, reason: lastReason });
    } finally {
      clearTimeout(timer);
    }
  }

  eventLog.error('ai.grade.failed', { reason: lastReason, attempts });
  return { ok: false, warnings: [], reason: lastReason, latencyMs: Date.now() - started, attempts };
}
