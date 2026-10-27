import { describe, expect, it } from 'vitest';

import { base64ToBytes, bytesToBase64 } from '../src/core/base64';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('base64 解码', () => {
  it('往返一致（RFC 4648 的经典向量）', () => {
    const cases = ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'Hello, 世界!'];
    for (const text of cases) {
      const bytes = new TextEncoder().encode(text);
      const b64 = bytesToBase64(bytes);
      const back = base64ToBytes(b64);
      expect(Array.from(back)).toEqual(Array.from(bytes));
    }
  });

  it('标准向量值正确', () => {
    expect(bytesToBase64(new TextEncoder().encode('f'))).toBe('Zg==');
    expect(bytesToBase64(new TextEncoder().encode('fo'))).toBe('Zm8=');
    expect(bytesToBase64(new TextEncoder().encode('foo'))).toBe('Zm9v');
    expect(bytesToBase64(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy');
  });

  it('PNG 头能正确还原', () => {
    const b64 = bytesToBase64(Uint8Array.from(PNG_HEADER));
    expect(Array.from(base64ToBytes(b64))).toEqual(PNG_HEADER);
  });

  it('容忍 data URL 前缀与换行', () => {
    const b64 = bytesToBase64(Uint8Array.from(PNG_HEADER));
    const messy = `data:image/png;base64,${b64.slice(0, 4)}\n${b64.slice(4)}`;
    expect(Array.from(base64ToBytes(messy))).toEqual(PNG_HEADER);
  });

  it('随机字节往返', () => {
    for (let len = 1; len <= 64; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + len * 11) & 0xff;
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('非法字符与非法填充给可读错误', () => {
    expect(() => base64ToBytes('Zm9v$$')).toThrow(/非法字符/);
    expect(() => base64ToBytes('Zg===')).toThrow(/填充非法/);
  });
});
