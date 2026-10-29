/**
 * 调色着色器（SkSL）。只有字符串，不依赖 Skia，所以可以被单测/静态检查覆盖。
 *
 * 管线顺序（一次 pass）：
 *   线性域：白平衡 → 曝光
 *   显示域：降噪 → 对比 → 高光/阴影 → 白场/黑场 → 去雾 → 褪色 → 3D LUT →
 *           饱和度 → 自然饱和 → 色相/HSL 八色带 → 分离色调 → 色调曲线 →
 *           清晰度/锐化 → 颗粒 → 暗角
 *
 * 为什么要分两个色彩域：色温/曝光是物理上乘增益的操作，必须在线性光做；
 * 而对比、LUT、颗粒是"看"出来的，放在显示域（sRGB）才符合直觉，也才和
 * Lightroom / 达芬奇的 .cube 行为一致。
 *
 * 三个必须逐字对齐的地方：
 *   1. uniform 的声明顺序 = PARAM_LIST 顺序（uniformsFor 按它压 number[]）
 *   2. uv 的 x = (r*(n-1)+0.5)/n，y = (b*n + g*(n-1) + 0.5)/(n*n)
 *   3. lut 纹理必须用 nearest 采样（跨色块插值会得到"发灰/恒定色"的假象）；
 *      curve 纹理是 256 级一维表，用 linear 反而更平滑
 */
export const GRADE_SKSL = `
uniform shader img;
uniform shader lut;
uniform shader curve;
uniform float2 srcSize;
uniform float lutSize;
uniform float hasLut;
uniform float hasCurve;

uniform float brightness;
uniform float contrast;
uniform float saturation;
uniform float vibrance;
uniform float hue;
uniform float temperature;
uniform float tint;
uniform float highlights;
uniform float shadows;
uniform float whites;
uniform float blacks;
uniform float fade;
uniform float dehaze;
uniform float splitShadowHue;
uniform float splitShadowSat;
uniform float splitHighlightHue;
uniform float splitHighlightSat;
uniform float redHue;
uniform float redSat;
uniform float redLum;
uniform float orangeHue;
uniform float orangeSat;
uniform float orangeLum;
uniform float yellowHue;
uniform float yellowSat;
uniform float yellowLum;
uniform float greenHue;
uniform float greenSat;
uniform float greenLum;
uniform float aquaHue;
uniform float aquaSat;
uniform float aquaLum;
uniform float blueHue;
uniform float blueSat;
uniform float blueLum;
uniform float purpleHue;
uniform float purpleSat;
uniform float purpleLum;
uniform float magentaHue;
uniform float magentaSat;
uniform float magentaLum;
uniform float sharpen;
uniform float clarity;
uniform float noiseReduction;
uniform float grain;
uniform float vignette;
uniform float lutStrength;

const half3 LUMA = half3(0.2126, 0.7152, 0.0722);

// sRGB 传输曲线用**精确分段函数**而不是 pow(2.2) 近似：
// 近似在近白/近黑处会白给 5% 的误差，而 CPU 参考实现（core/grade.ts）用的是精确版，
// 两边对不齐就没法用自动比对来兜住"参数符号写反"这类回归。
half3 toLinear(half3 c) {
  half3 v = max(c, 0.0);
  half3 lo = v / 12.92;
  half3 hi = pow((v + 0.055) / 1.055, half3(2.4));
  return half3(
    v.r <= 0.04045 ? lo.r : hi.r,
    v.g <= 0.04045 ? lo.g : hi.g,
    v.b <= 0.04045 ? lo.b : hi.b
  );
}

half3 toSrgb(half3 c) {
  half3 v = max(c, 0.0);
  half3 lo = v * 12.92;
  half3 hi = 1.055 * pow(v, half3(1.0 / 2.4)) - 0.055;
  return half3(
    v.r <= 0.0031308 ? lo.r : hi.r,
    v.g <= 0.0031308 ? lo.g : hi.g,
    v.b <= 0.0031308 ? lo.b : hi.b
  );
}

half luma(half3 c) { return dot(c, LUMA); }

// ---------- HSL 工具 ----------
half3 rgb2hsl(half3 c) {
  half mx = max(c.r, max(c.g, c.b));
  half mn = min(c.r, min(c.g, c.b));
  half l = (mx + mn) * 0.5;
  half d = mx - mn;
  if (d < 0.0001) return half3(0.0, 0.0, l);

  half s = l > 0.5 ? d / max(0.0001, 2.0 - mx - mn) : d / max(0.0001, mx + mn);
  half h;
  // 必须用「等于最大值」判定，而不是 >=：当蓝是最大值时，r >= g 也可能成立，
  // 会错走红色分支 —— 蓝色像素的色相会整块算错（HSL 面板直接失灵）。
  if (mx == c.r) {
    h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  } else if (mx == c.g) {
    h = (c.b - c.r) / d + 2.0;
  } else {
    h = (c.r - c.g) / d + 4.0;
  }
  return half3(h / 6.0, s, l);
}

half hue2rgb(half p, half q, half t) {
  half tt = t;
  if (tt < 0.0) tt += 1.0;
  if (tt > 1.0) tt -= 1.0;
  if (tt < 1.0 / 6.0) return p + (q - p) * 6.0 * tt;
  if (tt < 0.5) return q;
  if (tt < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - tt) * 6.0;
  return p;
}

half3 hsl2rgb(half3 hsl) {
  half h = hsl.x;
  half s = hsl.y;
  half l = hsl.z;
  if (s < 0.0001) return half3(l);
  half q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  half p = 2.0 * l - q;
  return half3(
    hue2rgb(p, q, h + 1.0 / 3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0 / 3.0)
  );
}

// 色带权重：以 center 为中心的三角形分布，按 360° 环绕
half bandWeight(half hueDeg, half center, half halfWidth) {
  half d = abs(hueDeg - center);
  d = min(d, 360.0 - d);
  return clamp(1.0 - d / halfWidth, 0.0, 1.0);
}

// 全局色相旋转 + HSL 八色带混合：先旋转，再按旋转后的色相归属加权
half3 applyHueMix(half3 c) {
  half3 hsl = rgb2hsl(c);
  half hueDeg = fract(hsl.x + hue / 360.0) * 360.0;
  hsl.x = hueDeg / 360.0;

  half wR = bandWeight(hueDeg, 0.0, 45.0);
  half wO = bandWeight(hueDeg, 30.0, 45.0);
  half wY = bandWeight(hueDeg, 60.0, 45.0);
  half wG = bandWeight(hueDeg, 120.0, 55.0);
  half wA = bandWeight(hueDeg, 180.0, 55.0);
  half wB = bandWeight(hueDeg, 240.0, 50.0);
  half wP = bandWeight(hueDeg, 280.0, 45.0);
  half wM = bandWeight(hueDeg, 320.0, 45.0);
  // 按最大权重归一，而不是按和：纯红这种落在色带中心颜色必须拿到 100% 的调整量，
  // 按和归一会因为相邻色带也有一点权重而被稀释（红色饱和 -100 只能减一半）。
  half wMax = max(max(max(wR, wO), max(wY, wG)), max(max(wA, wB), max(wP, wM)));
  half wNorm = max(0.0001, wMax);

  half dHue = (wR * redHue + wO * orangeHue + wY * yellowHue + wG * greenHue +
               wA * aquaHue + wB * blueHue + wP * purpleHue + wM * magentaHue) / wNorm;
  half dSat = (wR * redSat + wO * orangeSat + wY * yellowSat + wG * greenSat +
               wA * aquaSat + wB * blueSat + wP * purpleSat + wM * magentaSat) / wNorm;
  half dLum = (wR * redLum + wO * orangeLum + wY * yellowLum + wG * greenLum +
               wA * aquaLum + wB * blueLum + wP * purpleLum + wM * magentaLum) / wNorm;

  // ±100 → ±60°；饱和按比例缩放；明度加权（中间调最敏感，端点收敛）
  hsl.x = fract(hsl.x + dHue * (60.0 / 360.0) / 100.0);
  hsl.y = clamp(hsl.y * (1.0 + dSat / 100.0), 0.0, 1.0);
  half midWeight = 1.0 - abs(hsl.z * 2.0 - 1.0);
  hsl.z = clamp(hsl.z + dLum / 100.0 * 0.28 * midWeight, 0.0, 1.0);

  return hsl2rgb(hsl);
}

// 分离色调：以中灰为中心的色度向量，按阴影/高光权重叠加（不整体提亮）
half3 splitColor(half hueDeg, half amount, half weight) {
  if (amount <= 0.01) return half3(0.0);
  half3 base = hsl2rgb(half3(fract(hueDeg / 360.0), 1.0, 0.5));
  return (base - half3(0.5)) * (amount / 100.0) * weight;
}

// 色调曲线：三个通道各取一次（纹理里已经是"主曲线 ∘ 单通道曲线"）
half3 applyCurve(half3 c) {
  half3 s = clamp(c, 0.0, 1.0);
  half r = curve.eval(float2(float(s.r) * 255.0 + 0.5, 0.5)).r;
  half g = curve.eval(float2(float(s.g) * 255.0 + 0.5, 0.5)).g;
  half b = curve.eval(float2(float(s.b) * 255.0 + 0.5, 0.5)).b;
  return half3(r, g, b);
}

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

  // ---- 降噪：对源图做一次 5 点平滑（只在开启时才有采样开销）----
  if (noiseReduction > 0.01) {
    half3 neighbors = half3(img.eval(xy + float2(1.0, 0.0)).rgb) +
                      half3(img.eval(xy + float2(-1.0, 0.0)).rgb) +
                      half3(img.eval(xy + float2(0.0, 1.0)).rgb) +
                      half3(img.eval(xy + float2(0.0, -1.0)).rgb);
    half3 avg = (src * 4.0 + neighbors) / 8.0;
    src = mix(src, avg, half(noiseReduction / 100.0 * 0.85));
  }

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

  // ---- 白场 / 黑场：端点位置 ----
  if (abs(whites) > 0.01 || abs(blacks) > 0.01) {
    half endHi = smoothstep(0.6, 1.0, luma(c));
    half endLo = 1.0 - smoothstep(0.0, 0.4, luma(c));
    c += half3(whites / 100.0 * 0.22 * endHi) * (1.0 - c);
    c += half3(blacks / 100.0 * 0.22 * endLo) * (1.0 - c);
    c = clamp(c, 0.0, 1.0);
  }

  // ---- 去雾：中间调 S 曲线 + 饱和度（全局近似，不做局部对比）----
  if (abs(dehaze) > 0.01) {
    half dh = dehaze / 100.0;
    half lm = luma(c);
    half midMask = 1.0 - abs(lm * 2.0 - 1.0);
    c = clamp(c + half3(dh * 0.18 * (lm - 0.5) * midMask), 0.0, 1.0);
    c = mix(half3(luma(c)), c, clamp(1.0 + dh * 0.35, 0.0, 2.0));
  }

  // ---- 褪色（哑光）：抬黑位 + 略降反差 + 略去色 ----
  if (fade > 0.01) {
    half f = fade / 100.0;
    c = c * (1.0 - 0.14 * f) + 0.10 * f;
    c = mix(half3(luma(c)), c, 1.0 - 0.18 * f);
    c = clamp(c, 0.0, 1.0);
  }

  // ---- 3D LUT（浓度可调）----
  if (hasLut > 0.5) {
    c = mix(c, sampleLut(c), clamp(lutStrength / 100.0, 0.0, 1.0));
  }

  // ---- 饱和度 ----
  c = mix(half3(luma(c)), c, 1.0 + saturation / 100.0);

  // ---- 自然饱和：低饱和区优先，避免肤色与霓虹过火 ----
  if (abs(vibrance) > 0.01) {
    half mx = max(c.r, max(c.g, c.b));
    half mn = min(c.r, min(c.g, c.b));
    half sat = mx - mn;
    // 权重只看当前色度：越鲜艳，增益越小。饱和像素（sat≈0.7）几乎不受影响。
    half weight = clamp(1.0 - sat * 1.4, 0.0, 1.0);
    half factor = max(0.0, 1.0 + vibrance / 100.0 * weight);
    half lv = luma(c);
    c = half3(lv + (c.r - lv) * factor, lv + (c.g - lv) * factor, lv + (c.b - lv) * factor);
  }

  // ---- 色相旋转 + HSL 八色带 ----
  if (abs(hue) > 0.01 || abs(redHue) + abs(redSat) + abs(redLum) +
      abs(orangeHue) + abs(orangeSat) + abs(orangeLum) +
      abs(yellowHue) + abs(yellowSat) + abs(yellowLum) +
      abs(greenHue) + abs(greenSat) + abs(greenLum) +
      abs(aquaHue) + abs(aquaSat) + abs(aquaLum) +
      abs(blueHue) + abs(blueSat) + abs(blueLum) +
      abs(purpleHue) + abs(purpleSat) + abs(purpleLum) +
      abs(magentaHue) + abs(magentaSat) + abs(magentaLum) > 0.01) {
    c = applyHueMix(c);
  }

  // ---- 分离色调：阴影染一个色、高光染另一个色 ----
  if (splitShadowSat > 0.01 || splitHighlightSat > 0.01) {
    half lc = luma(c);
    half shadowMask = 1.0 - smoothstep(0.0, 0.6, lc);
    half highlightMask = smoothstep(0.4, 1.0, lc);
    c += splitColor(splitShadowHue, splitShadowSat, shadowMask);
    c += splitColor(splitHighlightHue, splitHighlightSat, highlightMask);
    c = clamp(c, 0.0, 1.0);
  }

  // ---- 色调曲线（恒等曲线时跳过 3 次纹理取样）----
  if (hasCurve > 0.5) {
    c = applyCurve(c);
  }

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
 * 前三个是 shader 类型的子节点（img、lut、curve），由 makeShaderWithChildren 按顺序绑定。
 */
export const GRADE_UNIFORM_KEYS = [
  'img',
  'lut',
  'curve',
  'srcSize',
  'lutSize',
  'hasLut',
  'hasCurve',
  'brightness',
  'contrast',
  'saturation',
  'vibrance',
  'hue',
  'temperature',
  'tint',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'fade',
  'dehaze',
  'splitShadowHue',
  'splitShadowSat',
  'splitHighlightHue',
  'splitHighlightSat',
  'redHue',
  'redSat',
  'redLum',
  'orangeHue',
  'orangeSat',
  'orangeLum',
  'yellowHue',
  'yellowSat',
  'yellowLum',
  'greenHue',
  'greenSat',
  'greenLum',
  'aquaHue',
  'aquaSat',
  'aquaLum',
  'blueHue',
  'blueSat',
  'blueLum',
  'purpleHue',
  'purpleSat',
  'purpleLum',
  'magentaHue',
  'magentaSat',
  'magentaLum',
  'sharpen',
  'clarity',
  'noiseReduction',
  'grain',
  'vignette',
  'lutStrength',
] as const;
