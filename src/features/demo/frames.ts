/**
 * 演示素材（由 scripts/demo-assets.mjs 生成，来源可复现）。
 *
 * 用途：
 *  - 没有 A7M2 实机时，取景循环、一拍一传、图库、调色、导出全流程都能跑通；
 *  - 每张图刻意覆盖一种调色难点，方便验证 shader 是否按预期工作。
 */

export interface DemoFrame {
  key: string;
  label: string;
  hint: string;
  module: number;
  width: number;
  height: number;
}

const W = 1200;
const H = 800;

export const DEMO_FRAMES: DemoFrame[] = [
  {
    key: 'dusk',
    label: '暮色',
    hint: '暖冷对比，测色温',
    module: require('../../../assets/demo/scene-dusk.png'),
    width: W,
    height: H,
  },
  {
    key: 'dawn',
    label: '晨光',
    hint: '大面积高光，测高光恢复',
    module: require('../../../assets/demo/scene-dawn.png'),
    width: W,
    height: H,
  },
  {
    key: 'ink',
    label: '夜蓝',
    hint: '低调噪点，测阴影与颗粒',
    module: require('../../../assets/demo/scene-ink.png'),
    width: W,
    height: H,
  },
  {
    key: 'skin',
    label: '肤色',
    hint: '肤色带，测饱和度保护',
    module: require('../../../assets/demo/scene-skin.png'),
    width: W,
    height: H,
  },
  {
    key: 'moss',
    label: '苔原',
    hint: '大面积中间调绿，测清晰度',
    module: require('../../../assets/demo/scene-moss.png'),
    width: W,
    height: H,
  },
  {
    key: 'chart',
    label: '色卡',
    hint: '24 色 + 灰阶，验准用',
    module: require('../../../assets/demo/scene-chart.png'),
    width: W,
    height: H,
  },
];

export const DEMO_FRAME_MODULES = DEMO_FRAMES.map((f) => f.module);

/** 取景循环用的帧（按顺序切换，模拟相机推流）。 */
export const LIVE_FRAME_MODULES = DEMO_FRAME_MODULES;
