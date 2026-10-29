/**
 * AI 供应商目录与请求地址解析（纯逻辑，可单测）。
 *
 * 这个 App 只依赖一件事：**OpenAI 兼容的 `/chat/completions`**（图片走
 * `image_url` data URL，返回 JSON）。所以"换供应商"本质就是换 base URL + 模型名，
 * 不需要为每家写适配器 —— 但地址的写法五花八门（带不带 /v1、用户直接粘完整
 * 的 /chat/completions、本地 Ollama 没写协议头），必须有一处统一归一化。
 *
 * 目录里的默认模型不保证永远可用：各家模型名迭代很快，所以设置页允许覆盖，
 * 且"测试连接"会用真实请求验证。
 */

import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from './ai';

/** 认证头风格：绝大多数是 Bearer，Azure OpenAI 用 api-key */
export type AiAuthStyle = 'bearer' | 'api-key';

export interface AiProvider {
  id: string;
  /** 展示名（中文优先） */
  name: string;
  /** 默认请求地址（不含 /chat/completions）；留空表示必须由用户填写 */
  baseUrl: string;
  /** 默认模型名；留空表示必须由用户填写 */
  model: string;
  /** 官方文档里是否支持图片输入（只作提示，实际以测试连接为准） */
  vision: boolean;
  /** 是否支持 response_format=json_object（不支持时客户端会自动降级重试） */
  jsonMode: boolean;
  /** 认证头：bearer = Authorization: Bearer，api-key = api-key 头 */
  auth: AiAuthStyle;
  /** 是否必须填 Key（本地模型通常不需要） */
  requiresKey: boolean;
  /** 一句话说明，设置页直接显示 */
  note: string;
  /** 申请 Key / 接口文档地址 */
  docs?: string;
}

export const DEFAULT_PROVIDER_ID = 'deepseek';

/**
 * 常用供应商（均为 OpenAI 兼容接口，按国内可用性 + 视觉能力挑选）。
 * 地址取自各家官方文档的 "OpenAI 兼容 / compatible" 入口。
 */
export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: DEEPSEEK_BASE_URL,
    model: DEEPSEEK_MODEL,
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '默认供应商；deepseek-flash 支持图片与 JSON 输出',
    docs: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '官方接口；国内访问通常需要代理',
    docs: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'dashscope',
    name: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max-latest',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '百炼的 OpenAI 兼容入口；qwen-vl 系列支持图片',
    docs: 'https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k-vision-preview',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '需使用带 vision 的模型名',
    docs: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: 'glm-4v 系列支持图片；地址带 /api/paas/v4',
    docs: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '一个 Key 可调多家开源模型，模型名区分大小写',
    docs: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '聚合多家模型；模型名形如 vendor/model',
    docs: 'https://openrouter.ai/keys',
  },
  {
    id: 'volcengine',
    name: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-1.5-vision-pro-32k',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '通常要填「接入点 ID」（ep-...）作为模型名',
    docs: 'https://console.volcengine.com/ark',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-vision',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '混元视觉模型；官方正在把能力迁往 TokenHub，地址若有变化可直接改这一栏',
    docs: 'https://console.cloud.tencent.com/hunyuan/api-key',
  },
  {
    id: 'qianfan',
    name: '百度千帆',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'ernie-4.5-turbo-vl',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: 'v2 为 OpenAI 兼容入口',
    docs: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'MiniMax-VL-01',
    vision: true,
    jsonMode: false,
    auth: 'bearer',
    requiresKey: true,
    note: '视觉模型，JSON 输出靠提示词约束（客户端会自动降级）',
    docs: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-1v-8k',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: 'step-1v 系列支持图片',
    docs: 'https://platform.stepfun.com/interface-key',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '推理速度很快；可用模型以控制台为准',
    docs: 'https://console.groq.com/keys',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-2-vision-1212',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: 'grok-2-vision 支持图片输入',
    docs: 'https://console.x.ai',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'pixtral-12b-2409',
    vision: true,
    jsonMode: false,
    auth: 'bearer',
    requiresKey: true,
    note: 'Pixtral 支持图片',
    docs: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '开源模型托管',
    docs: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    baseUrl: '',
    model: '',
    vision: true,
    jsonMode: true,
    auth: 'api-key',
    requiresKey: true,
    note: '请填完整部署地址：https://<资源>.openai.azure.com/openai/deployments/<部署名>/chat/completions?api-version=2024-10-21',
    docs: 'https://learn.microsoft.com/azure/ai-services/openai/reference',
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5vl:7b',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: false,
    note: '本机跑模型；手机访问电脑需把 127.0.0.1 换成电脑局域网 IP',
    docs: 'https://ollama.com/library/qwen2.5vl',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: false,
    note: '需在 LM Studio 里开启 Local Server 并加载视觉模型',
    docs: 'https://lmstudio.ai/docs/app/api',
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    vision: true,
    jsonMode: true,
    auth: 'bearer',
    requiresKey: true,
    note: '任何兼容 /chat/completions 的服务（含自建网关、one-api/new-api 等），填地址与模型名即可',
  },
];

const PROVIDER_MAP = new Map(AI_PROVIDERS.map((provider) => [provider.id, provider]));

export function findProvider(id: string | null | undefined): AiProvider {
  return PROVIDER_MAP.get(id ?? '') ?? PROVIDER_MAP.get(DEFAULT_PROVIDER_ID)!;
}

export function providerById(id: string): AiProvider | null {
  return PROVIDER_MAP.get(id) ?? null;
}

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i;
const PRIVATE_IPV4 =
  /^(10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/;

export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return LOOPBACK_HOST.test(host) || PRIVATE_IPV4.test(host);
}

/** 本地地址（Ollama / LM Studio / 局域网网关）通常不需要 Key，也用 http */
export function isLocalUrl(url: string): boolean {
  const normalized = normalizeAiBaseUrl(url);
  if (!normalized) return false;
  try {
    return isLocalHost(new URL(normalized).hostname);
  } catch {
    return false;
  }
}

/**
 * 归一化用户输入的 base 地址：
 *  - 去首尾空白；
 *  - 没写协议时补 http://（本地）或 https://；
 *  - 去掉结尾多余的斜杠；
 *  - 只接受 http/https，其它协议返回空串（由调用方提示）。
 */
export function normalizeAiBaseUrl(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) return '';

  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const host = candidate.split(/[/:?#]/)[0] ?? '';
    candidate = `${isLocalHost(host) ? 'http' : 'https'}://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path || '/';
  const rendered = url.toString();
  // URL 会给根路径补一个结尾斜杠，这里统一去掉，避免拼接时出现双斜杠
  return rendered.endsWith('/') && !url.search ? rendered.slice(0, -1) : rendered;
}

/** 拼出真正的 /chat/completions 地址（用户已经粘了完整地址时原样返回）。 */
export function resolveChatUrl(baseUrl: string): string {
  const base = normalizeAiBaseUrl(baseUrl);
  if (!base) return '';

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return '';
  }

  const path = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(path)) {
    url.pathname = path;
    return url.toString();
  }
  url.pathname = `${path}/chat/completions`;
  return url.toString();
}

/** 拼出 /models（用于"测试连接"里不花钱的一次探测）。 */
export function resolveModelsUrl(baseUrl: string): string {
  const base = normalizeAiBaseUrl(baseUrl);
  if (!base) return '';

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return '';
  }

  const path = url.pathname.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
  url.pathname = `${path}/models`;
  return url.toString();
}

export interface AiConfig {
  provider: AiProvider;
  providerId: string;
  providerName: string;
  /** 归一化后的 base 地址（可能是空串） */
  baseUrl: string;
  model: string;
  chatUrl: string;
  modelsUrl: string;
  auth: AiAuthStyle;
  /** 本次请求是否必须带 Key（本地地址自动放宽） */
  requiresKey: boolean;
  jsonMode: boolean;
  /** 空串表示配置完整可直接发请求 */
  missing: string;
  local: boolean;
}

export interface AiSettingsSlice {
  aiProviderId?: string;
  aiBaseUrl?: string;
  aiModel?: string;
}

/**
 * 把设置里的「供应商 + 地址覆盖 + 模型覆盖」合成一次请求需要的配置。
 * 覆盖值为空时回落到供应商默认，这样切换供应商只需要改 id。
 */
export function effectiveAiConfig(input: AiSettingsSlice): AiConfig {
  const provider = findProvider(input.aiProviderId);
  const baseUrl = normalizeAiBaseUrl(input.aiBaseUrl) || normalizeAiBaseUrl(provider.baseUrl);
  const model = (input.aiModel ?? '').trim() || provider.model;
  const chatUrl = resolveChatUrl(baseUrl);
  const local = Boolean(baseUrl) && isLocalUrl(baseUrl);

  let missing = '';
  if (!baseUrl) missing = '请求地址未填写';
  else if (!chatUrl) missing = '请求地址无效（只支持 http/https）';
  else if (!model) missing = '模型名未填写';

  return {
    provider,
    providerId: provider.id,
    providerName: provider.name,
    baseUrl,
    model,
    chatUrl,
    modelsUrl: resolveModelsUrl(baseUrl),
    auth: provider.auth,
    requiresKey: provider.requiresKey && !local,
    jsonMode: provider.jsonMode,
    missing,
    local,
  };
}

/** 设置页展示用：地址过长时截断中间部分。 */
export function shortenUrl(url: string, max = 52): string {
  if (!url || url.length <= max) return url;
  const keep = Math.floor((max - 3) / 2);
  return `${url.slice(0, keep)}…${url.slice(url.length - keep)}`;
}
