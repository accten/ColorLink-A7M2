import {
  AlphaType,
  ColorType,
  FilterMode,
  ImageFormat,
  MipmapMode,
  Skia,
  TileMode,
  type SkImage,
  type SkRuntimeEffect,
} from '@shopify/react-native-skia';

import { Lut3D, identityLut, packLut } from '@/core/lut';
import { EditParams } from '@/core/params';
import { GRADE_SKSL } from '@/features/grading/shader';
import { fitWithin, uniformsFor, uniformsObject } from '@/core/grade';

export { fitWithin, uniformsFor, uniformsObject };

/**
 * 调色渲染层（只负责 GPU 相关的事）。
 *
 * 预览：编辑器里的 <Canvas> 用声明式 <Shader> 上屏。
 * 导出：离屏 Surface **两趟** —— 先把原图重采样到目标尺寸，再用调色 shader 以
 * 1:1 纹理映射画一遍。分两趟是必须的：
 *   - ImageShader 的坐标是像素空间，直接放大 rect 只会"裁切左上角"，不会缩放；
 *   - 让 shader 只负责调色、让 drawImageRect 只负责缩放，两边都简单且可验证。
 */

let effectCache: SkRuntimeEffect | null | undefined;
let placeholder: SkImage | null = null;

export function getGradeEffect(): SkRuntimeEffect | null {
  if (effectCache !== undefined) return effectCache;
  effectCache = Skia.RuntimeEffect.Make(GRADE_SKSL);
  return effectCache;
}

function imageFromRgba(packed: { width: number; height: number; pixels: Uint8Array }): SkImage | null {
  const data = Skia.Data.fromBytes(packed.pixels);
  return Skia.Image.MakeImage(
    {
      width: packed.width,
      height: packed.height,
      colorType: ColorType.RGBA_8888,
      alphaType: AlphaType.Unpremul,
    },
    data,
    packed.width * 4,
  );
}

const lutImageCache = new WeakMap<Lut3D, SkImage>();

export function lutSkImage(lut: Lut3D | null | undefined): SkImage | null {
  if (!lut) return null;
  const cached = lutImageCache.get(lut);
  if (cached) return cached;
  const image = imageFromRgba(packLut(lut));
  if (image) lutImageCache.set(lut, image);
  return image;
}

/** 没有 LUT 时也必须给 uniform shader 绑一张纹理，否则 shader 编译失败。 */
export function placeholderLutImage(): SkImage | null {
  if (placeholder) return placeholder;
  placeholder = imageFromRgba(packLut(identityLut(2)));
  return placeholder;
}

export function decodeImage(bytes: Uint8Array): SkImage | null {
  return Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
}

/**
 * 屏幕预览用的降采样副本。
 *
 * 编辑页只需要上屏，没必要把 24MP 原图整张塞进 GPU 纹理：A7M2 的 6000×4000 大约
 * 96MB 显存，低端机直接 OOM。导出走的是另一条路径（重新从文件解码原图），
 * 所以这里放心降。
 */
export function makePreviewImage(image: SkImage, maxLongEdge = 1440): SkImage {
  const sourceWidth = image.width();
  const sourceHeight = image.height();
  const longEdge = Math.max(sourceWidth, sourceHeight);
  if (longEdge <= maxLongEdge) return image;

  const scale = maxLongEdge / longEdge;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const surface = Skia.Surface.MakeOffscreen(width, height);
  if (!surface) return image;
  surface.getCanvas().drawImageRectOptions(
    image,
    Skia.XYWHRect(0, 0, sourceWidth, sourceHeight),
    Skia.XYWHRect(0, 0, width, height),
    FilterMode.Linear,
    MipmapMode.None,
  );
  return surface.makeImageSnapshot();
}

export interface Histogram {
  /** 每个通道 64 个桶，已归一化到 0..1 */
  r: number[];
  g: number[];
  b: number[];
  luma: number[];
  /** 采样像素数（0 表示没算出来） */
  sampled: number;
}

const HISTOGRAM_BINS = 64;
const HISTOGRAM_SAMPLE_EDGE = 160;

/**
 * 从图片算 RGB / 亮度直方图。
 *
 * 做法：先把图缩到 ~160px 再读像素 —— 直接读 24MP 内存会炸，而直方图对采样噪声不敏感。
 * 任何一步失败都返回 null（直方图是锦上添花，不能因为它让编辑器报错）。
 */
export function computeHistogram(image: SkImage): Histogram | null {
  try {
    const scale = Math.min(1, HISTOGRAM_SAMPLE_EDGE / Math.max(image.width(), image.height(), 1));
    const width = Math.max(1, Math.round(image.width() * scale));
    const height = Math.max(1, Math.round(image.height() * scale));

    const surface = Skia.Surface.MakeOffscreen(width, height);
    if (!surface) return null;
    surface.getCanvas().drawImageRectOptions(
      image,
      Skia.XYWHRect(0, 0, image.width(), image.height()),
      Skia.XYWHRect(0, 0, width, height),
      FilterMode.Linear,
      MipmapMode.None,
    );
    const pixels = surface.makeImageSnapshot().readPixels();
    if (!pixels || pixels.length < width * height * 4) return null;

    const r = new Array<number>(HISTOGRAM_BINS).fill(0);
    const g = new Array<number>(HISTOGRAM_BINS).fill(0);
    const b = new Array<number>(HISTOGRAM_BINS).fill(0);
    const luma = new Array<number>(HISTOGRAM_BINS).fill(0);
    const step = HISTOGRAM_BINS / 256;

    for (let index = 0; index + 3 < pixels.length; index += 4) {
      const pr = pixels[index];
      const pg = pixels[index + 1];
      const pb = pixels[index + 2];
      r[Math.min(HISTOGRAM_BINS - 1, Math.floor(pr * step))] += 1;
      g[Math.min(HISTOGRAM_BINS - 1, Math.floor(pg * step))] += 1;
      b[Math.min(HISTOGRAM_BINS - 1, Math.floor(pb * step))] += 1;
      const l = Math.round(0.2126 * pr + 0.7152 * pg + 0.0722 * pb);
      luma[Math.min(HISTOGRAM_BINS - 1, Math.floor(l * step))] += 1;
    }

    const sampled = width * height;
    return { r: normalize(r, sampled), g: normalize(g, sampled), b: normalize(b, sampled), luma: normalize(luma, sampled), sampled };
  } catch {
    return null;
  }
}

/** 用 99 分位归一化，避免个别高柱把整张直方图压扁 */
function normalize(bins: number[], total: number): number[] {
  if (!total) return bins;
  const sorted = [...bins].sort((a, b) => a - b);
  const peak = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1] || 1;
  return bins.map((value) => Math.min(1, value / peak));
}

export interface RenderOptions {
  image: SkImage;
  params: EditParams;
  lut?: Lut3D | null;
  width: number;
  height: number;
  quality?: number;
}

export function renderGradedJpeg(options: RenderOptions): Uint8Array {
  const effect = getGradeEffect();
  if (!effect) throw new Error('调色着色器编译失败');

  const { width, height } = options;
  const sourceWidth = options.image.width();
  const sourceHeight = options.image.height();
  const needsResample = sourceWidth !== width || sourceHeight !== height;

  // 第一趟：重采样到目标尺寸（仅在需要时）
  let base: SkImage = options.image;
  if (needsResample) {
    const resampleSurface = Skia.Surface.MakeOffscreen(width, height);
    if (!resampleSurface) throw new Error(`无法创建 ${width}×${height} 的离屏画布（显存不足）`);
    const resampleCanvas = resampleSurface.getCanvas();
    resampleCanvas.drawImageRectOptions(
      options.image,
      Skia.XYWHRect(0, 0, sourceWidth, sourceHeight),
      Skia.XYWHRect(0, 0, width, height),
      FilterMode.Linear,
      MipmapMode.None,
    );
    base = resampleSurface.makeImageSnapshot();
  }

  // 第二趟：1:1 纹理 + 调色 shader
  const surface = Skia.Surface.MakeOffscreen(width, height);
  if (!surface) throw new Error(`无法创建 ${width}×${height} 的离屏画布（显存不足）`);

  const canvas = surface.getCanvas();
  const paint = Skia.Paint();

  const sourceShader = base.makeShaderOptions(
    TileMode.Clamp,
    TileMode.Clamp,
    FilterMode.Linear,
    MipmapMode.None,
  );

  const lut = lutSkImage(options.lut) ?? placeholderLutImage();
  if (!lut) throw new Error('LUT 纹理创建失败');

  const lutShader = lut.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Nearest, MipmapMode.None);

  const uniforms = uniformsFor(options.params, width, height, options.lut?.size ?? 2, Boolean(options.lut));
  const shader = effect.makeShaderWithChildren(uniforms, [sourceShader, lutShader]);
  paint.setShader(shader);
  canvas.drawRect(Skia.XYWHRect(0, 0, width, height), paint);

  const snapshot = surface.makeImageSnapshot();
  return snapshot.encodeToBytes(ImageFormat.JPEG, options.quality ?? 92);
}
