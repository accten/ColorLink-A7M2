/**
 * Base64 ↔ Uint8Array（纯逻辑，无依赖）。
 *
 * 为什么自己写：演示素材要"内联进 JS"（见 demoAssets），落盘时得把 base64 还原成字节。
 * Hermes 上 `atob` 是否可用随版本变化，手写一份 30 行的解码器比赌运行时能力可靠，
 * 而且能直接单测（含非法字符、填充、长度边界）。
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < CHARS.length; i++) table[CHARS.charCodeAt(i)] = i;
  return table;
})();

export function base64ToBytes(input: string): Uint8Array {
  if (!input) return new Uint8Array(0);

  // 容忍换行、空白与 data URL 前缀
  const comma = input.indexOf(',');
  let body = comma >= 0 ? input.slice(comma + 1) : input;
  body = body.replace(/[\s\r\n\t]/g, '');

  let padding = 0;
  while (body.endsWith('=')) {
    padding += 1;
    body = body.slice(0, -1);
  }

  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < body.length; i++) {
    const value = LOOKUP[body.charCodeAt(i) & 0xff];
    if (value < 0) throw new Error(`base64 非法字符：'${body[i]}'（位置 ${i}）`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }

  if (padding > 2) throw new Error(`base64 填充非法：${padding} 个 '='`);
  return outIndex === out.length ? out : out.subarray(0, outIndex);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : CHARS[b2 & 0x3f];
  }
  return out;
}
