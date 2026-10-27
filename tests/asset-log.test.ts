import { describe, expect, it } from 'vitest';

import {
  exportFileName,
  fileNameFromUri,
  formatBytes,
  formatDimensions,
  formatMegapixels,
  ingestFileName,
  newAssetId,
  stamp,
} from '../src/core/asset';
import { EventLog, redact } from '../src/core/log';

describe('命名规则', () => {
  const date = new Date(2026, 9, 29, 14, 30, 12);

  it('时间戳格式固定', () => {
    expect(stamp(date)).toBe('20261029_143012');
  });

  it('落盘名带三位序号，不会覆盖', () => {
    expect(ingestFileName(date, 4)).toBe('20261029_143012_004.jpg');
    expect(ingestFileName(date, 4, '.png')).toBe('20261029_143012_004.png');
  });

  it('导出名遵循 原名_edited_时间戳，且固定 .jpg', () => {
    expect(exportFileName('DSC01234.JPG', date)).toBe('DSC01234_edited_20261029_143012.jpg');
    expect(exportFileName('photo', date)).toBe('photo_edited_20261029_143012.jpg');
    // 源图是 PNG 时也不能沿用 .png：输出一律是 JPEG 编码
    expect(exportFileName('demo_dusk.png', date)).toBe('demo_dusk_edited_20261029_143012.jpg');
  });

  it('assetId 唯一', () => {
    expect(newAssetId(date, 1)).not.toBe(newAssetId(date, 2));
  });

  it('从 uri 取文件名（含 content://）', () => {
    expect(fileNameFromUri('file:///data/ingest/20261029_143012_001.jpg')).toBe('20261029_143012_001.jpg');
    expect(fileNameFromUri('content://media/external/images/123?x=1')).toBe('123');
  });
});

describe('格式化', () => {
  it('字节数', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('尺寸与像素数', () => {
    expect(formatDimensions(6000, 4000)).toBe('6000 × 4000');
    expect(formatMegapixels(6000, 4000)).toBe('24.0 MP');
  });
});

describe('日志脱敏', () => {
  it('打码 key/token 类字段与 sk- 前缀', () => {
    const out = redact({ apiKey: 'abc123', nested: { token: 'xyz' }, note: 'sk-1234567890abcdef' }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe('***');
    expect((out.nested as Record<string, unknown>).token).toBe('***');
    expect(out.note).toBe('sk-***');
  });

  it('截断超长 base64，不整段落日志', () => {
    const b64 = 'A'.repeat(400);
    expect(redact({ image: b64 })).toEqual({ image: '[base64 400 chars]' });
  });

  it('环形缓冲超容量后丢最旧', () => {
    const log = new EventLog(3);
    log.info('a');
    log.warn('b');
    log.error('c');
    log.info('d');
    const list = log.list();
    expect(list).toHaveLength(3);
    expect(list[0].event).toBe('b');
    expect(list[2].event).toBe('d');
  });

  it('导出文本包含级别与事件', () => {
    const log = new EventLog(10);
    log.info('camera.connect', { model: 'ILCE-7M2' });
    const text = log.toText();
    expect(text).toContain('INFO');
    expect(text).toContain('camera.connect');
    expect(text).toContain('ILCE-7M2');
  });
});
