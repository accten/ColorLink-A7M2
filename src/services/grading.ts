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
