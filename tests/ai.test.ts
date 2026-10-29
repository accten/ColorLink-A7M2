import { describe, expect, it } from 'vitest';

import {
  GRADE_SYSTEM_PROMPT,
  buildGradeRequestBody,
  buildUserText,
  estimateDataUrlBytes,
  extractJsonObject,
  looksLikeNoop,
  parseGradeContent,
} from '../src/core/ai';
import { DEFAULT_PARAMS } from '../src/core/params';

describe('extractJsonObject', () => {
  it('从 ```json 围栏里取对象', () => {
    expect(extractJsonObject('```json\n{"brightness":5}\n```')).toBe('{"brightness":5}');
  });

  it('从前后废话里取对象', () => {
    expect(extractJsonObject('好的，参数如下：{"a":{"b":1}} 完毕')).toBe('{"a":{"b":1}}');
  });

  it('处理字符串里的花括号', () => {
    const json = '{"note":"a { brace } inside","brightness":3}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it('没有对象时返回 null', () => {
    expect(extractJsonObject('没有 json')).toBeNull();
    expect(extractJsonObject(null)).toBeNull();
    expect(extractJsonObject('{"unclosed": 1')).toBeNull();
  });
});

describe('parseGradeContent', () => {
  it('解析合法参数', () => {
    const result = parseGradeContent('{"brightness":5,"contrast":12,"temperature":20}');
    expect(result.ok).toBe(true);
    expect(result.params?.brightness).toBe(5);
    expect(result.params?.contrast).toBe(12);
    expect(result.params?.temperature).toBe(20);
    expect(result.params?.grain).toBe(0);
  });

  it('夹取越界值并给出 warning', () => {
    const result = parseGradeContent('{"temperature":220,"sharpen":-8}');
    expect(result.ok).toBe(true);
    expect(result.params?.temperature).toBe(100);
    expect(result.params?.sharpen).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('空内容给出可读原因', () => {
    const result = parseGradeContent('   ');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('空');
  });

  it('非 JSON 给出可读原因', () => {
    const result = parseGradeContent('我觉得可以更暖一点');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('JSON');
  });

  it('坏 JSON 不抛异常', () => {
    const result = parseGradeContent('{"brightness": }');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('解析');
  });

  it('只有未知字段视为无效', () => {
    const result = parseGradeContent('{"foo":1,"bar":2}');
    expect(result.ok).toBe(false);
  });

  it('顶层是数组视为无效', () => {
    expect(parseGradeContent('[1,2,3]').ok).toBe(false);
  });
});

describe('looksLikeNoop', () => {
  it('全 0 判定为无效', () => {
    expect(looksLikeNoop(DEFAULT_PARAMS, '调成胶片感')).toBe(true);
  });

  it('重置类指令不算无效', () => {
    expect(looksLikeNoop(DEFAULT_PARAMS, '重置一下')).toBe(false);
  });

  it('有任意调整就不算无效', () => {
    expect(looksLikeNoop({ ...DEFAULT_PARAMS, grain: 10 }, '胶片')).toBe(false);
  });
});

describe('请求体', () => {
  const body = buildGradeRequestBody({
    instruction: '调成胶片感，偏暖',
    currentParams: DEFAULT_PARAMS,
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
  }) as {
    model: string;
    messages: { role: string; content: unknown }[];
    response_format: { type: string };
    max_tokens: number;
  };

  it('模型与 JSON 模式正确', () => {
    expect(body.model).toBe('deepseek-flash');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('不支持 JSON 模式的供应商可以去掉 response_format', () => {
    const plain = buildGradeRequestBody({
      instruction: '调成胶片感',
      currentParams: DEFAULT_PARAMS,
      imageDataUrl: 'data:image/jpeg;base64,AAAA',
      model: 'some-model',
      jsonMode: false,
    }) as Record<string, unknown>;
    expect(plain.response_format).toBeUndefined();
    expect(plain.model).toBe('some-model');
  });

  it('多模态内容结构不变（图片只在 user 消息里）', () => {
    const user = body.messages.find((m) => m.role === 'user') as { content: { type: string; image_url?: { url: string } }[] };
    expect(user.content[1].image_url?.url).toBe('data:image/jpeg;base64,AAAA');
  });

  it('图片放在 user 消息的多模态 content 里', () => {
    const user = body.messages.find((m) => m.role === 'user');
    const parts = user?.content as { type: string }[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
    expect(parts.some((p) => p.type === 'text')).toBe(true);
  });

  it('system prompt 含 json 关键词与示例（JSON Output 的硬要求）', () => {
    expect(GRADE_SYSTEM_PROMPT.toLowerCase()).toContain('json');
    expect(GRADE_SYSTEM_PROMPT).toContain('"brightness"');
    expect(body.messages[0].role).toBe('system');
  });

  it('user 文本包含当前参数与历史', () => {
    const text = buildUserText({
      instruction: '再暖一点',
      currentParams: { ...DEFAULT_PARAMS, temperature: 10 },
      history: [{ instruction: '调成胶片感', params: DEFAULT_PARAMS }],
    });
    expect(text).toContain('再暖一点');
    expect(text).toContain('"temperature":10');
    expect(text).toContain('调成胶片感');
  });
});

describe('estimateDataUrlBytes', () => {
  it('按 base64 长度估算字节数', () => {
    expect(estimateDataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3);
    expect(estimateDataUrlBytes('AAAA')).toBe(3);
  });
});
