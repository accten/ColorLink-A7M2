/**
 * 演示素材。
 *
 * 每张图有两个来源：
 *  - `module`：`require()` 的打包资源，用于界面显示（expo-image / Skia 都能直接吃）
 *  - `base64`：同一张图的字节内联，用于"落盘成相机回传文件"
 *
 * 为什么要 base64：release 包里 `expo-asset` 的 `uri` 是资源键（`assets_demo_scenedusk`）
 * 而不是文件路径，`new File(...)` 会抛 "URI is not absolute"。内联字节彻底绕开这个边界，
 * 且不依赖 expo-updates / 缓存目录的可写性。
 */
import { DEMO_B64, DEMO_HEIGHT, DEMO_WIDTH } from './framesB64';

export interface DemoFrame {
  key: string;
  label: string;
  hint: string;
  module: number;
  base64: string;
  width: number;
  height: number;
}

const W = DEMO_WIDTH;
const H = DEMO_HEIGHT;

const frames: Omit<DemoFrame, 'base64' | 'width' | 'height'>[] = [
  {
    key: 'dusk',
    label: '暮色',
    hint: '暖冷对比，测色温',
    module: require('../../../assets/demo/scene-dusk.png'),
  },
  {
    key: 'dawn',
    label: '晨光',
    hint: '大面积高光，测高光恢复',
    module: require('../../../assets/demo/scene-dawn.png'),
  },
  {
    key: 'ink',
    label: '夜蓝',
    hint: '低调噪点，测阴影与颗粒',
    module: require('../../../assets/demo/scene-ink.png'),
  },
  {
    key: 'skin',
    label: '肤色',
    hint: '肤色带，测饱和度保护',
    module: require('../../../assets/demo/scene-skin.png'),
  },
  {
    key: 'moss',
    label: '苔原',
    hint: '大面积中间调绿，测清晰度',
    module: require('../../../assets/demo/scene-moss.png'),
  },
  {
    key: 'chart',
    label: '色卡',
    hint: '24 色 + 灰阶，验准用',
    module: require('../../../assets/demo/scene-chart.png'),
  },
];

export const DEMO_FRAMES: DemoFrame[] = frames.map((frame) => {
  const base64 = DEMO_B64[frame.key];
  if (!base64) {
    throw new Error(`演示素材缺少内联字节：${frame.key}（请重新运行 node scripts/demo-assets.mjs）`);
  }
  return { ...frame, base64, width: W, height: H };
});

export const DEMO_FRAME_MODULES = DEMO_FRAMES.map((f) => f.module);

/** 取景循环用的帧（按顺序切换，模拟相机推流）。 */
export const LIVE_FRAME_MODULES = DEMO_FRAME_MODULES;
