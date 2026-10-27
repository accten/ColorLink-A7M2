# 基础验证与常规测试报告

- 版本：ColorLink v0.1.0
- 环境：Windows 11 / Node 24.15 / npm 11.12 / Expo SDK 58.0.19 / RN 0.88 / TypeScript 6.0.3
- 结论：**静态质量门全绿；本轮共发现并修复 6 个缺陷（含 2 个会直接导致产物错误的真 bug）**。
  由于本机没有 Java / Android SDK，**APK 构建与真机用例未执行**，第 4 节给出可直接照做的手测清单。

---

## 1. 执行的检查项与结果

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | 类型检查（strict） | `npx tsc --noEmit` | ✅ 0 error |
| 2 | Lint（eslint-config-expo + react-hooks 规则） | `npx eslint app src tests` | ✅ 0 error / 0 warning |
| 3 | 纯逻辑单测 | `npx vitest run` | ✅ 7 文件 / **99 用例全通过** |
| 4 | 依赖与配置体检 | `npx expo-doctor` | ✅ 20/20 通过 |
| 5 | 应用配置解析 | `npx expo config --type public` | ✅ 通过（含插件解析） |
| 6 | 生产打包（Metro + Hermes） | `npx expo export -p android` | ✅ 生成 android bundle |
| 7 | 素材生成可复现 | `node scripts/demo-assets.mjs`、`node scripts/brand-assets.mjs` | ✅ 6 场景 + 5 图标 |
| 8 | APK 构建 / 真机运行 | `npx expo prebuild && expo run:android` | ⏸ 未执行（缺 Android SDK / JDK） |

### 覆盖范围（单测按文件）

| 文件 | 用例 | 覆盖内容 |
|---|---|---|
| `params.test.ts` | 13 | 夹取、归一化、缺字段/未知字段、diff、格式化 |
| `lut.test.ts` | 10 | `.cube` 解析、1D 拒绝、尺寸/数据量校验、打包布局、三线性取样 |
| `ai.test.ts` | 19 | JSON 抠取（围栏/废话/字符串内花括号）、越界夹取、空内容、无效字段、请求体结构、`json` 关键词 |
| `asset-log.test.ts` | 11 | 命名规则、导出扩展名、摘要规范化、日志脱敏、环形缓冲 |
| `grade.test.ts` | 19 | uniform 顺序/长度、导出尺寸计算、参数语义（提亮/暖冷/饱和度/高光/阴影/暗角/单调性/边界） |
| `shader.test.ts` | 12 | SKSL 与 JS 的 uniform 契约、LUT 坐标与打包同步、管线顺序、无时间项 |
| `pipeline.test.ts` | 15 | 一拍一传去重、文件名不覆盖、预设合法性与覆盖面、AI 无变化判定 |

---

## 2. 本轮发现并修复的缺陷

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| B-1 | **导出只裁切不缩放**：`ImageShader` 的坐标是像素空间，直接按目标尺寸画 rect 只会取原图左上角 | 导出 4000px 时得到"放大后的左上角"而不是整图，成品直接不可用 | 导出改为两趟：先 `drawImageRectOptions` 重采样到目标尺寸，再用 1:1 纹理跑调色 shader（`src/services/grading.ts`） |
| B-2 | **uniform 顺序与 SKSL 声明不一致**：`PARAM_LIST` 按 UI 分组排列（高光/阴影在饱和度之前），SKSL 按职能排列 | 参数串位（拖"饱和度"实际改了"色温"），颜色错但界面一切正常，极难肉眼定位 | 以 SKSL 为准重排 `PARAM_LIST` 并在注释里写明"顺序即契约"；新增 `tests/shader.test.ts` 双端钉死 |
| B-3 | **同一秒导出两次会覆盖文件** | 违反 FR-07「不覆盖已有输出」，连拍后连续导出会丢结果 | 新增 `uniqueFileName()`（`-2`/`-3` 递增），导出路径接入 |
| B-4 | 导出扩展名沿用源图（PNG 源 → 内容为 JPEG 的 `.png`） | 部分相册/编辑器按扩展名解码失败 | `exportFileName()` 固定 `.jpg`，并加用例锁定 |
| B-5 | `app.json` 含非法字段 `androidNavigationBar`（SDK 58 已移出 schema） | `expo prebuild` 前的配置校验失败，构建可能直接中止 | 删除该字段；`expo-doctor` 恢复 20/20 |
| B-6 | 6 处 React 反模式：渲染期读写 `ref`、effect 内同步 `setState`、`useRef(new Animated.Value())` | 未来 React Compiler 下会出隐蔽的重渲染/动画失效；也是 lint 报错来源 | 轨道宽度改 `useState`，动画值改 `useState(() => new Animated.Value())`，effect 内只做异步更新；快门反馈改为按压时触发 |

> B-1、B-2 属于"编译通过、界面正常、结果错误"的类型，正是这一轮验证最有价值的产出。

---

## 3. 验收用例（TC-01 ~ TC-15）当前状态

| 用例 | 场景 | 现在能验到哪一步 | 状态 |
|---|---|---|---|
| TC-01 | 插入 A7M2 → 10s 内已连接 | 状态机/错误码/10s 超时有实现；需真机 | ⏸ 待真机（M0） |
| TC-02 | 取景 5s 内出画面 | 演示帧路径可在真机验证；真机 PTP 取景待 M0 | 部分可验 |
| TC-03 | 快门 → 5s 内进列表 | 演示模式端到端可验（写盘/摘要/入库） | ✅ 演示可验 |
| TC-04 | 连拍 5 张不重不漏 | 去重逻辑单测覆盖（5 次含重复 → 3 张）；真机待验 | 部分 |
| TC-05 | 滑块 ≥24fps | 交互档按 ≤1080p 设计；需真机 `gfxinfo` | ⏸ 待真机 |
| TC-06 | 预设 500ms 内生效 | 纯状态切换，无 IO；可测 | ✅ |
| TC-07 | 合法 `.cube` 生效 / 非法报错 | 解析器 19 个用例覆盖（含 1D、尺寸不符、坏行） | ✅ 逻辑可验 |
| TC-08 | AI 8s 内应用 | 请求/校验/重试链路完整；需真实 Key | 部分 |
| TC-09 | 非法 JSON 不崩 | 用例覆盖空内容/坏 JSON/未知字段/数组 | ✅ |
| TC-10 | 保存后原图哈希不变 | 导出前后都算 SHA-256 并对比，不符会记 `export.original.changed` | ✅ 逻辑可验 |
| TC-11 | 导出后相册可见 | MediaStore 调用已接；需真机授权 | ⏸ 待真机 |
| TC-12 | 取景中拔线不崩 | 拔线由 expo-sony-camera 上报，`usb.ts` 未接 | ⏸ 待真机 |
| TC-13 | 未配 Key 时 AI 置灰 | UI 判定 + 单测（`looksLikeNoop` 边界） | ✅ |
| TC-14 | 断网提示网络错误、参数不变 | 超时/网络错误分支齐全；需真机断网验证 | 部分 |
| TC-15 | 删除需二次确认 | `Alert` 确认 + 取消不产生副作用 | ✅ |

---

## 4. 真机手测清单（约 20 分钟，按顺序执行）

前置：`npm install && npx expo prebuild -p android && npx expo run:android`（首次建议插着 USB 线调试）。

### 4.1 演示模式主流程（不需要相机）

1. 冷启动 → 首页显示 `ILCE-7M2 / 演示模式 / 已连接`，图库应有 6 张素材。
2. 进「取景」→ 画面在 6 张之间轮播，顶部显示 LIVE / 14 FPS / 78%。
3. 点快门 → 震动一次 → 退出取景后「最近接收」出现新照片。
4. 图库 → 点第一张 → 编辑器：
   - 拖「亮度 / 对比度 / 饱和度 / 色温」→ 画面实时变化，肉眼应能看出方向正确
     （+亮度更亮、+色温更暖、-饱和度更灰、+对比更硬）。
   - 「按住对比」→ 显示原图，松手恢复。
   - 「预设」→ 6 个预设逐个点，胶片/电影感应有明显风格差异。
   - 「AI」→ 未配置 Key 时应提示去设置；配置后输入"调成胶片感，偏暖"，8s 内出参数与 diff 列表。
5. 「保存到相册」→ 通知里出现 `xxx_edited_<时间戳>.jpg`；系统相册可见；再保存一次应出现 `-2` 后缀而不是覆盖。
6. 图库长按 → 删除 → 确认框；取消后照片仍在。
7. 设置 → 导出长边改 2048 → 再导出，文件体积应明显变小。
8. 设置 → 导出日志 → 通知里给出日志文件路径；日志中**不应**出现 `sk-` 或大段 base64。

### 4.2 真机联机（M0，需要相机）

按 `docs/sony-transport.md` 接入 `expo-sony-camera` 后：

1. 相机 USB 模式设为「PC 遥控」，插线 → 10s 内首页状态变「已连接」，型号为 `ILCE-7M2`。
2. 开始取景 → 5s 内出画面；记录 `adb logcat -s SonyCameraController:*` 里的
   `D221` 状态、`live-view cycle` 日志。
3. 按机身快门 → 5s 内出现新照片（关注 `D215` 日志）。
4. 取景中拔线 → 3s 内回「未连接」，无崩溃。
5. 把上述日志与现象填进 `docs/compatibility-report.md`（M0 交付物）。

---

## 5. 未覆盖项（诚实清单）

1. **GPU 着色器未在真机跑过**：能做的是 CPU 参考实现 + 契约测试，实际画面需真机确认（尤其 LUT 与锐化）。
2. **Skia 离屏渲染的显存上限**：4000px 导出未实测；6000px 有 OOM 风险（设置里可切）。
3. **真机 USB 全链路**：依赖 M0；当前 `usb.ts` 明确失败而不是假装可用。
4. **性能指标**（≥24fps、≤5s 传输）需要真机 `gfxinfo` / 计时打点验证。
5. **相册权限拒绝路径**：代码有分支（`granted=false` 时只落本地），未在真机走一遍。
6. **Android 各版本差异**（API 29~36 的 MediaStore 行为）未做矩阵。

---

## 6. 复现命令

```bash
npx tsc --noEmit          # 类型
npx eslint app src tests  # 静态检查
npx vitest run            # 99 个用例
npx expo-doctor           # 依赖/配置
npx expo export -p android --output-dir .export-check   # 生产打包（产物可删）
```
