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

// 3D LUT：8 点三线性插值。
// 之前只对蓝轴插值、r/g 直接取最近邻，17³ 的 LUT 会把连续色阶量化成 17 级，
// 真机上表现为一圈圈同心色带。LUT 纹理必须用 nearest 取"准确的网格点"，
// 但网格之间的插值必须自己做。
half3 sampleLut(half3 c) {
  float n = max(lutSize, 2.0);
  float3 f = float3(clamp(c, 0.0, 1.0)) * (n - 1.0);
  float3 i0 = floor(f);
  float3 i1 = min(i0 + 1.0, n - 1.0);
  float3 t = f - i0;

  half3 acc = half3(0.0);
  for (int z = 0; z < 2; z++) {
    float bz = (z == 0) ? i0.z : i1.z;
    float wz = (z == 0) ? (1.0 - t.z) : t.z;
    float rowBase = bz * n + 0.5;

    half3 slice = half3(0.0);
    for (int y = 0; y < 2; y++) {
      float gy = (y == 0) ? i0.y : i1.y;
      float wy = (y == 0) ? (1.0 - t.y) : t.y;
      float py = rowBase + gy;

      half3 s0 = half3(lut.eval(float2(i0.x + 0.5, py)).rgb);
      half3 s1 = half3(lut.eval(float2(i1.x + 0.5, py)).rgb);
      slice += mix(s0, s1, half(t.x)) * half(wy);
    }
    acc += slice * half(wz);
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
