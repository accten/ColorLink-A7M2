import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// src 下的模块用 `@/...` 自引用（对应 tsconfig 的 paths）。测试直接 import src 里的
// 服务时会顺着这些自引用继续解析，所以这里要给同样的映射，否则只能测叶子模块。
const srcRoot = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@': srcRoot } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
