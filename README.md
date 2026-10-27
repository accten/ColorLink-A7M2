# ColorLink · A7M2 联机监视 + 一拍一传 + 本地调色

索尼 A7M2（ILCE-7M2）通过 USB OTG 连接安卓手机：实时取景、按一次快门自动回传一张、
在手机上做手动调色 / LUT / AI 调色，结果另存并导出相册。**只调色，不做美颜。**

技术栈：Expo SDK 58（React Native 0.88）+ Expo Router + `@shopify/react-native-skia`（SkSL 调色）
+ DeepSeek `deepseek-flash`（视觉 + JSON 输出）。

---

## 当前状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 取景 / 拍摄 / 一拍一传 | **演示模式可跑** | 用代码生成的 6 张素材模拟推流与快门，走完整 ingest 链路 |
| 真机 USB 联机 | **待 M0 验证** | `src/services/camera/usb.ts` 是明确失败的占位实现，接入步骤见 `docs/sony-transport.md` |
| 手动调色（11 参数） | 可用 | 单 pass SkSL，GPU 实时预览 |
| 3D LUT（.cube） | 可用 | 解析 → 2D 纹理打包 → shader 三线性取样；坏文件给明确原因 |
| 预设（6 个内置） | 可用 | 原图 / 胶片 / 电影感 / 清透 / 暖调 / 冷调 |
| AI 调色 | 可用（需 API Key） | 自然语言 → 结构化参数 JSON → 本地渲染；失败保留原参数 |
| 保存 / 导出相册 | 可用 | `原名_edited_时间戳.jpg`，质量默认 92，原图 SHA-256 前后校验 |
| 事件日志 / 导出 | 可用 | 自动脱敏（Key、图片 base64 不入日志） |

> 演示模式不是"假页面"：它把素材当作相机回传的 JPEG 写进 `ingest/`，算 SHA-256 去重、
> 入库、渲染、导出——所以从相机层往上的所有代码都是真的，M0 通过后只需替换 `usb.ts`。

## 快速开始

```bash
npm install
npx expo prebuild --platform android   # Skia / SecureStore / MediaLibrary 都是原生模块，需要 dev build
npx expo run:android                   # 装到真机
```

首次启动会自动连上演示相机；也可以到「相机」页手动连接。

### 在 GitHub 上直接打 APK

仓库已内置 GitHub Actions 工作流（`.github/workflows/android-apk.yml`），推送到 `main` 即自动：

1. 跑静态门禁（typecheck / lint / 99 个单测）；
2. `expo prebuild` 生成原生工程；
3. `./gradlew assembleRelease` 出 **自包含 APK**（已内联 Hermes bundle，不依赖 Metro）；
4. 把 APK 作为 Actions artifact 上传（保留 30 天）。

取包路径：`GitHub → Actions → Android APK → 最近一次运行 → 页面底部 Artifacts → colorlink-apk`，
解压得到 `app-release.apk`；也可以命令行 `gh run download <run-id> -n colorlink-apk`。
首次构建约 15~25 分钟（含 Gradle/NDK 冷启动），之后有缓存会快很多。

> 这里产出的 release APK 由 Expo prebuild 默认的 **debug keystore** 签名，可以直接
> `adb install` 到手机自测，但没有正式签名，不能上架、也不适合对外分发。
> 需要正式签名时按 `docs/ci.md` 加 4 个 Secrets 并改用 release 签名配置。


```bash
npm run typecheck   # tsc --noEmit（strict，0 error）
npm run lint        # eslint（含 react-hooks 规则，0 error / 0 warning）
npm test            # vitest：99 个纯逻辑用例（参数 / LUT / AI / 命名 / 日志 / 着色器契约 / 去重）
npm run start       # 仅 Metro（已装过 dev build 时用）
```

验证结果与真机手测清单见 `docs/qa-report.md`。当前状态：类型 / lint / 单测 / expo-doctor(20/20) /
Metro 生产打包全部通过；APK 构建与真机用例需要装有 JDK + Android SDK 的机器（本仓库的开发环境没有）。

生成素材（改了配色或想换风格时）：

```bash
node scripts/demo-assets.mjs    # assets/demo/scene-*.png（6 张，1200×800）
node scripts/brand-assets.mjs   # 图标 / 启动图 / 自适应图标
```

## 目录

```
app/                      expo-router 路由
  (tabs)/index.tsx        相机（连接 / 状态 / 最近接收）
  (tabs)/gallery.tsx      图库
  (tabs)/settings.tsx     设置（Key / 导出 / 诊断）
  live.tsx                取景（全屏）
  editor/[id].tsx         编辑器（预览 / 三面板 / 保存）
src/
  core/                   纯逻辑：params · presets · lut · ai · asset · log（可单测，无 RN 依赖）
  design/                 tokens + 12 个 UI 原语
  features/grading/       SkSL 着色器源码
  features/demo/          演示帧清单
  services/               camera / grading / exportImage / lutStore / library / settings / ingest / aiClient
  state/useAppStore.ts    zustand（相机、图库、编辑会话、提示、设置）
  components/NoticeHost.tsx
tests/                    vitest
docs/                     design.md · sony-transport.md
scripts/                  素材生成器
```

## 几个关键设计决定

1. **相机层抽象成 `ICameraTransport`**：演示 / 真机 / 未来的 gphoto2 都实现它，UI 与 store 零改动。
   （回应需求「联机、调色、AI 三层解耦」）
2. **调色只有一个着色器**：白平衡/曝光在线性光算，对比/LUT/饱和度在显示域算，最后统一 sRGB 输出；
   预览与导出共用同一份 SkSL 与同一套 uniform 顺序，保证"看到的就是导出的"。
3. **图像字节不过 JS 桥**：真机取景由原生 View 上屏，一拍一传只回传文件路径；摘要用原生 digest 算。
4. **AI 只出参数**：模型返回的 JSON 会被逐字段校验、夹取、记录 warning；非法结果重试一次后保留原参数。
5. **演示模式是正式功能**：没有相机也能验证全链路，也是回归测试的夹具来源。

## 限制与风险

- **A7M2 的 PTP2 方言尚未验证**：`expo-sony-camera` 官方实测机型只有 `ILCE-7M3` / `ILCE-6700`，
  仓库里搜不到 `ILCE-7M2`。必须按 `实现方案.md` 第 6 节做 M0。
- Sony 已公告 **Camera Control PTP2 命令可能自 2027 年起在部分机型失效**；相机层因此做成可替换实现。
- **峰值对焦做不到**：PTP 不提供该数据，A7M2 上改为「按住对比 / 放大查看」。
- 全分辨率导出（6000px）在低端机上可能 OOM，默认 4000px。
- MVP 不含 RAW、视频、多相机、相机参数远程控制。

## 文档

- `需求.md` — 需求规格
- `实现方案.md` — 技术选型核实、三条联机路线、协议事实表、M0 执行包、验收映射
- `docs/qa-report.md` — 基础验证与常规测试报告（含本轮修复的 6 个缺陷、TC-01~15 状态、真机手测清单）
- `docs/design.md` — 界面设计参考与令牌
- `docs/sony-transport.md` — 接入 `expo-sony-camera` 的具体步骤与 A7M2 补丁点

## 第三方

- `expo-sony-camera`（MIT）— 计划 vendor 到 `packages/sony-camera`，保留其 LICENSE 与版权声明
- `@shopify/react-native-skia`（MIT）
- 演示素材与图标均由 `scripts/*.mjs` 用代码生成，不含任何第三方图片
