import { describe, expect, it } from 'vitest';

import {
  AI_PROVIDERS,
  DEFAULT_PROVIDER_ID,
  effectiveAiConfig,
  findProvider,
  isLocalUrl,
  normalizeAiBaseUrl,
  providerById,
  resolveChatUrl,
  resolveModelsUrl,
  shortenUrl,
} from '../src/core/aiProvider';

describe('供应商目录', () => {
  it('id 唯一、名称非空、默认供应商存在', () => {
    expect(new Set(AI_PROVIDERS.map((p) => p.id)).size).toBe(AI_PROVIDERS.length);
    for (const provider of AI_PROVIDERS) {
      expect(provider.name.trim().length).toBeGreaterThan(0);
      expect(provider.note.trim().length).toBeGreaterThan(0);
    }
    expect(providerById(DEFAULT_PROVIDER_ID)).not.toBeNull();
    expect(findProvider('不存在的供应商').id).toBe(DEFAULT_PROVIDER_ID);
  });

  it('非空默认地址都是合法的 http(s)，且归一化后不变', () => {
    for (const provider of AI_PROVIDERS) {
      if (!provider.baseUrl) continue;
      const normalized = normalizeAiBaseUrl(provider.baseUrl);
      expect(normalized, provider.id).toBe(provider.baseUrl);
      expect(resolveChatUrl(provider.baseUrl)).toContain('/chat/completions');
    }
  });

  it('Azure 与自定义必须由用户填地址', () => {
    expect(providerById('azure')?.baseUrl).toBe('');
    expect(providerById('custom')?.baseUrl).toBe('');
    expect(providerById('azure')?.auth).toBe('api-key');
  });
});

describe('normalizeAiBaseUrl', () => {
  it('保留合法地址，去掉结尾斜杠', () => {
    expect(normalizeAiBaseUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com');
    expect(normalizeAiBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com');
    expect(normalizeAiBaseUrl('  https://api.openai.com/v1///  ')).toBe('https://api.openai.com/v1');
  });

  it('没写协议时补齐：公网 https，本地 http', () => {
    expect(normalizeAiBaseUrl('api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(normalizeAiBaseUrl('127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
    expect(normalizeAiBaseUrl('localhost:1234/v1')).toBe('http://localhost:1234/v1');
    expect(normalizeAiBaseUrl('192.168.1.10:11434/v1')).toBe('http://192.168.1.10:11434/v1');
  });

  it('非法协议 / 空串 / 乱写返回空串', () => {
    expect(normalizeAiBaseUrl('ftp://example.com')).toBe('');
    expect(normalizeAiBaseUrl('file:///etc/passwd')).toBe('');
    expect(normalizeAiBaseUrl('')).toBe('');
    expect(normalizeAiBaseUrl('   ')).toBe('');
    expect(normalizeAiBaseUrl('not a url')).toBe('');
    expect(normalizeAiBaseUrl(null)).toBe('');
  });
});

describe('resolveChatUrl / resolveModelsUrl', () => {
  it('base 后面自动补 /chat/completions', () => {
    expect(resolveChatUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(resolveChatUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('已经粘了完整地址就原样使用（含结尾斜杠与查询串）', () => {
    expect(resolveChatUrl('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(resolveChatUrl('https://api.openai.com/v1/chat/completions/')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(
      resolveChatUrl('https://x.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21'),
    ).toBe('https://x.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21');
  });

  it('/models 从 base 推出，完整 chat 地址会被剥掉', () => {
    expect(resolveModelsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models');
    expect(resolveModelsUrl('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/models');
  });

  it('空地址不抛异常，返回空串', () => {
    expect(resolveChatUrl('')).toBe('');
    expect(resolveModelsUrl('')).toBe('');
    expect(resolveChatUrl('ftp://x')).toBe('');
  });
});

describe('isLocalUrl', () => {
  it('回环与私有网段算本地', () => {
    expect(isLocalUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLocalUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLocalUrl('http://192.168.1.20:8080/v1')).toBe(true);
    expect(isLocalUrl('http://10.0.0.5/v1')).toBe(true);
    expect(isLocalUrl('http://172.16.3.4/v1')).toBe(true);
  });

  it('公网地址不算本地', () => {
    expect(isLocalUrl('https://api.deepseek.com')).toBe(false);
    expect(isLocalUrl('http://172.32.0.1/v1')).toBe(false);
    expect(isLocalUrl('')).toBe(false);
  });
});

describe('effectiveAiConfig', () => {
  it('默认走 DeepSeek，配置完整', () => {
    const config = effectiveAiConfig({});
    expect(config.providerId).toBe(DEFAULT_PROVIDER_ID);
    expect(config.baseUrl).toBe('https://api.deepseek.com');
    expect(config.model).toBe('deepseek-flash');
    expect(config.chatUrl).toBe('https://api.deepseek.com/chat/completions');
    expect(config.requiresKey).toBe(true);
    expect(config.missing).toBe('');
  });

  it('覆盖地址与模型', () => {
    const config = effectiveAiConfig({
      aiProviderId: 'openai',
      aiBaseUrl: 'https://gateway.example.com/v1',
      aiModel: 'my-model',
    });
    expect(config.providerName).toBe('OpenAI');
    expect(config.baseUrl).toBe('https://gateway.example.com/v1');
    expect(config.chatUrl).toBe('https://gateway.example.com/v1/chat/completions');
    expect(config.model).toBe('my-model');
  });

  it('自定义供应商没填地址 / 模型时给出可读原因', () => {
    expect(effectiveAiConfig({ aiProviderId: 'custom' }).missing).toBe('请求地址未填写');

    const noModel = effectiveAiConfig({ aiProviderId: 'custom', aiBaseUrl: 'https://x.com/v1' });
    expect(noModel.missing).toBe('模型名未填写');
    expect(noModel.chatUrl).toBe('https://x.com/v1/chat/completions');
  });

  it('非法地址覆盖会回落到供应商默认（设置读取时也会清洗）', () => {
    const config = effectiveAiConfig({ aiBaseUrl: 'ftp://nope' });
    expect(config.baseUrl).toBe('https://api.deepseek.com');
    expect(config.missing).toBe('');
  });

  it('本地供应商不需要 Key，公网自定义指向局域网也不需要', () => {
    expect(effectiveAiConfig({ aiProviderId: 'ollama' }).requiresKey).toBe(false);
    expect(effectiveAiConfig({ aiProviderId: 'ollama' }).local).toBe(true);
    expect(
      effectiveAiConfig({ aiProviderId: 'custom', aiBaseUrl: 'http://192.168.1.9:8000/v1', aiModel: 'm' }).requiresKey,
    ).toBe(false);
  });

  it('未知供应商 id 回落到默认', () => {
    expect(effectiveAiConfig({ aiProviderId: 'gone', aiBaseUrl: 'https://x.com/v1', aiModel: 'm' }).providerId).toBe(
      DEFAULT_PROVIDER_ID,
    );
  });
});

describe('shortenUrl', () => {
  it('短地址原样返回，长地址中间省略', () => {
    expect(shortenUrl('https://a.com/v1')).toBe('https://a.com/v1');
    const long = shortenUrl('https://very-long-host.example.com/openai/deployments/gpt4o/chat/completions?api-version=1', 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toContain('…');
    expect(long.startsWith('https://')).toBe(true);
  });
});
