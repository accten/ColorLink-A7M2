/**
 * 调色着色器（SkSL）。只有字符串，不依赖 Skia，所以可以被单测/静态检查覆盖。
 *
 * 管线顺序（一次 pass）：
 *   线性域：白平衡 → 曝光
 *   显示域：对比 → 高光/阴影 → 3D LUT → 饱和度 → 清晰度/锐化 → 颗粒 → 暗角
 *
 * 为什么要分两个色彩域：色温/曝光是物理上乘增益的操作，必须在线性光做；
 * 而对比、LUT、颗粒是"看"出来的，放在显示域（sRGB）才符合直觉，也才和
 * Lightroom / 达芬奇的 .cube 行为一致。
 *
 * 两个必须和 lut.ts 的打包布局逐字对齐的地方：
 *   1. uv 的 x = (r*(n-1)+0.5)/n，y = (b*n + g*(n-1) + 0.5)/(n*n)
 *   2. lut 纹理必须用 nearest 采样（跨色块插值会得到"发灰/恒定色"的假象）
 */
export const GRADE_SKSL = `
uniform shader img;
uniform shader lut;
uniform float2 srcSize;
uniform float lutSize;
uniform float hasLut;

uniform float brightness;
uniform float contrast;
uniform float saturation;
uniform float temperature;
uniform float tint;
uniform float highlights;
uniform float shadows;
uniform float sharpen;
uniform float clarity;
uniform float grain;
uniform float vignette;
uniform float lutStrength;

const half3 LUMA = half3(0.2126, 0.7152, 0.0722);

half3 toLinear(half3 c) { return pow(max(c, 0.0), half3(2.2)); }
half3 toSrgb(half3 c) { return pow(max(c, 0.0), half3(1.0 / 2.2)); }
half luma(half3 c) { return dot(c, LUMA); }

half3 sampleLut(half3 c) {
  float n = max(lutSize, 2.0);
  float b = clamp(c.b, 0.0, 1.0) * (n - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, n - 1.0);
  float bf = b - b0;

  float2 rg = clamp(c.rg, 0.0, 1.0) * (n - 1.0);
  half3 acc = half3(0.0);

  // 蓝轴两片之间插值；r/g 精确落在网格点上（纹理由 nearest 采样保证）
  for (int i = 0; i < 2; i++) {
    float bb = (i == 0) ? b0 : b1;
    float w = (i == 0) ? (1.0 - bf) : bf;
    float2 px = float2(rg.x + 0.5, bb * n + rg.y + 0.5);
    acc += half3(lut.eval(px).rgb) * half(w);
  }
  return acc;
}

half4 main(float2 xy) {
  float2 uv = xy / srcSize;
  half3 src = half3(img.eval(xy).rgb);

  // ---- 线性域：色温 / 色调 / 曝光 ----
  half3 lin = toLinear(src);
  lin *= half3(pow(2.0, temperature / 250.0),
               pow(2.0, -tint / 250.0),
               pow(2.0, -temperature / 250.0));
  lin *= pow(2.0, brightness / 50.0);
  half3 c = toSrgb(lin);

  // ---- 显示域：对比 ----
  half k = 1.0 + contrast / 100.0 * 0.8;
  c = clamp((c - 0.5) * k + 0.5, 0.0, 1.0);

  // ---- 高光 / 阴影（亮度加权）----
  half l = luma(c);
  half wHi = smoothstep(0.5, 1.0, l);
  half wLo = 1.0 - smoothstep(0.0, 0.5, l);
  c *= (1.0 + highlights / 200.0 * wHi) * (1.0 + shadows / 200.0 * wLo);
  c = clamp(c, 0.0, 1.0);

  // ---- 3D LUT（浓度可调）----
  if (hasLut > 0.5) {
    c = mix(c, sampleLut(c), clamp(lutStrength / 100.0, 0.0, 1.0));
  }

  // ---- 饱和度 ----
  c = mix(half3(luma(c)), c, 1.0 + saturation / 100.0);

  // ---- 清晰度 / 锐化（源图十字高通近似）----
  if (sharpen > 0.01 || clarity > 0.01) {
    half3 cross = half3(
      (img.eval(xy + float2(1.0, 0.0)).rgb +
       img.eval(xy + float2(-1.0, 0.0)).rgb +
       img.eval(xy + float2(0.0, 1.0)).rgb +
       img.eval(xy + float2(0.0, -1.0)).rgb) * 0.25
    );
    c += (src - cross) * (sharpen / 100.0 * 1.2 + clarity / 100.0 * 0.6);
  }

  // ---- 颗粒：坐标决定噪声，不随时间闪烁 ----
  if (grain > 0.01) {
    half n = half(fract(sin(dot(xy, float2(12.9898, 78.233))) * 43758.5453) - 0.5);
    half mask = half(1.0 - abs(float(luma(c)) - 0.5) * 1.2);
    c += n * (grain / 100.0 * 0.06) * mask;
  }

  // ---- 暗角 ----
  if (vignette > 0.01) {
    float r = length(uv - 0.5) * 1.41421356;
    c *= 1.0 - (vignette / 100.0) * smoothstep(0.35, 0.95, r);
  }

  return half4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/**
 * uniform 名与顺序必须和上面的声明逐字一致（tests/shader.test.ts 会把两边钉死）。
 * 前两个是 shader 类型的子节点（img、lut），由 makeShaderWithChildren 按顺序绑定。
 */
export const GRADE_UNIFORM_KEYS = [
  'img',
  'lut',
  'srcSize',
  'lutSize',
  'hasLut',
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'highlights',
  'shadows',
  'sharpen',
  'clarity',
  'grain',
  'vignette',
  'lutStrength',
] as const;
