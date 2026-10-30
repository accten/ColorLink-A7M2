# 基础验证与常规测试报告

- 版本：ColorLink v0.1.0
- 环境：Windows 11 / Node 24.15 / npm 11.12 / Expo SDK 58.0.19 / RN 0.88 / TypeScript 6.0.3
- 真机：OPPO Find X8 Ultra（PKJ110）/ Android 17 / 1440×3168 @640dpi，通过 adb 驱动实测
- 结论：静态质量门全绿；**真机实测又发现并修复 5 个缺陷**（资源读取、滑块交互、LUT 色带、相册导出 API、导出提示）。
  所有修复均已重新构建并在真机上复验。

---

## 0. 真机实测记录（adb 驱动，非人工点按）

| 项 | 结果 |
|---|---|
| 安装 / 冷启动 | ✅ `adb install` 成功，秒开 |
| 首页状态卡 / 底部 Tab | ✅ 与设计稿一致 |
| 演示素材种入 | ✅ 6 张（900×600，192–273 KB），`seeded → ingest.materialized` 日志正常 |
| 图库网格 | ✅ 6 张、倒序、0.5 MP 角标 |
| 编辑器渲染（Skia/SkSL） | ✅ 画面正常，参数面板分组与滑块齐备 |
| 亮度滑块（客观测量） | ✅ 基线 Luma 145.5 → +100 时 242.0；拖回中间**精确回到 145.5** |
| 点按圆点（修复前跳变） | ✅ 现在 145.5 → 144.5（不再跳到 -100） |
| 预设（胶片/电影感/暖调） | ✅ 暖调 R 177.6→189.8、B 114.8→110.8（方向正确） |
| LUT 导入（.cube，经系统文件选择器） | ✅ 导入成功、名称显示、浓度可调；三线性后无色带 |
| 导出 JPEG | ✅ `demo_dusk_edited_<时间戳>.jpg`，50 KB，写入 App 目录成功 |
| 保存到相册（MediaStore） | ✅ 改用 `Asset.create()` 后写入成功（见缺陷 D5） |
| 未配置 Key 的 AI 入口 | ⏳ 待复验（面板置灰/提示逻辑未变） |

### 真机暴露的 5 个缺陷

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| D1 | 图库 0 张、每次快门 `camera.capture.failed` | release 包里 `expo-asset` 的 `uri` 是资源键 `assets_demo_scenedusk`，`new File()` 抛 `URI is not absolute` | 演示素材改为**内联 base64**（`framesB64.ts`），落盘直接写字节，不再依赖 expo-asset 路径；新增 `core/base64.ts` + 6 个单测 |
| D2 | 手指按在滑块圆点上，数值直接跳到端点 | 用了 `locationX`（相对被按中的子视图） | 改 `pageX` + `measureInWindow` 记录轨道原点 |
| D3 | 套 LUT 后出现同心色带 | 只对蓝轴插值，r/g 用最近邻 → 17³ 量化成 17 级 | 8 点三线性插值（纹理仍 nearest） |
| D4 | 「保存到相册」静默失败，提示仍说"已保存" | 先 `requestPermissionsAsync` 在 Android 17 拿 denied 就跳过 | 直接写 MediaStore，失败再申请，并把原因如实显示 |
| D5 | 相册仍写不进去 | `saveToLibraryAsync` 在 SDK 58 已废弃、调用即抛错 | 改用新 API `Asset.create(uri)` |
| D6 | 连按快门 5 次，图库一张都没多 | 演示拍到的像素与种子图相同 → SHA-256 相同 → 被去重逻辑丢掉（日志 `ingest.duplicate` 连刷） | 去重只作用于真机传输；演示模式每次快门算新照片（`isDuplicateCapture(mode, …)`，含单测） |

> 另外把可观测性补上了：事件日志现在显示 data（错误原因），`console` 同步到 logcat；
> 否则 D1 只能看到 `library.seed.failed` 这一个词，根本定位不到 URI 问题。

---

## 1. 执行的检查项与结果

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | 类型检查（strict） | `npx tsc --noEmit` | ✅ 0 error |
| 2 | Lint（eslint-config-expo + react-hooks 规则） | `npx eslint app src tests` | ✅ 0 error / 0 warning |
| 3 | 纯逻辑单测 | `npx vitest run` | ✅ 13 文件 / **132 用例全通过**（v0.1.4 起） |
| 4 | 依赖与配置体检 | `npx expo-doctor` | ✅ 20/20 通过 |
| 5 | 应用配置解析 | `npx expo config --type public` | ✅ 通过（含插件解析） |
| 6 | 生产打包（Metro + Hermes） | `npx expo export -p android` | ✅ 生成 android bundle |
| 7 | 素材生成可复现 | `node scripts/demo-assets.mjs`、`node scripts/brand-assets.mjs` | ✅ 6 场景 + 5 图标 + base64 模块 |
| 8 | APK 构建 / 真机运行 | GitHub Actions + `adb install` | ✅ 构建 20 分钟，真机跑通 |

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

## 2. 静态阶段发现并修复的缺陷

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| B-1 | **导出只裁切不缩放**：`ImageShader` 的坐标是像素空间，直接按目标尺寸画 rect 只会取原图左上角 | 导出 4000px 时得到"放大后的左上角"而不是整图，成品直接不可用 | 导出改为两趟：先 `drawImageRectOptions` 重采样到目标尺寸，再用 1:1 纹理跑调色 shader（`src/services/grading.ts`） |
| B-2 | **uniform 顺序与 SKSL 声明不一致**：`PARAM_LIST` 按 UI 分组排列（高光/阴影在饱和度之前），SKSL 按职能排列 | 参数串位（拖"饱和度"实际改了"色温"），颜色错但界面一切正常，极难肉眼定位 | 以 SKSL 为准重排 `PARAM_LIST` 并在注释里写明"顺序即契约"；新增 `tests/shader.test.ts` 双端钉死 |
| B-3 | **同一秒导出两次会覆盖文件** | 违反「不覆盖已有输出」，连拍后连续导出会丢结果 | 新增 `uniqueFileName()`（`-2`/`-3` 递增），导出路径接入 |
| B-4 | 导出扩展名沿用源图（PNG 源 → 内容为 JPEG 的 `.png`） | 部分相册/编辑器按扩展名解码失败 | `exportFileName()` 固定 `.jpg`，并加用例锁定 |
| B-5 | `app.json` 含非法字段 `androidNavigationBar`（SDK 58 已移出 schema） | `expo prebuild` 前的配置校验失败，构建可能直接中止 | 删除该字段；`expo-doctor` 恢复 20/20 |
| B-6 | 6 处 React 反模式：渲染期读写 `ref`、effect 内同步 `setState`、`useRef(new Animated.Value())` | 未来 React Compiler 下会出隐蔽的重渲染/动画失效；也是 lint 报错来源 | 轨道宽度改 `useState`，动画值改 `useState(() => new Animated.Value())`，effect 内只做异步更新；快门反馈改为按压时触发 |

> B-1、B-2 属于"编译通过、界面正常、结果错误"的类型，是静态阶段最有价值的产出；
> 真机阶段的 D1~D5（见第 0 节）则全部是只有真机才会暴露的问题。

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
npx vitest run            # 132 个用例
npx expo-doctor           # 依赖/配置
npx expo export -p android --output-dir .export-check   # 生产打包（产物可删）
```

原生解析器（属性数组 / 对象载荷 / 曝光解码）另有本地通道，不需要 Android SDK：

```powershell
pwsh scripts/test-kotlin.ps1    # 49 个 Kotlin 用例，约 3 秒
```

## 7. 第六轮（v0.1.2 前）：真机复测与新增功能

在 OPPO Pad 4 Pro（Android 16）+ ILCE-7M2 上，用 build 35 / 36 逐项跑：

| 项目 | 结果 | 备注 |
|---|---|---|
| 冷启动、图库、设置页 | ✅ | 无崩溃；版本号读 app.json |
| 导出「原图 + 100」，未调色 | ✅ | `mode=original`、`bytes=279854`、`ms=5`（直接复制原图字节） |
| 导出「原图 + 100」，套胶片预设 | ✅ | `mode=graded`、900×600、q100、`ms=36` |
| 调色滑块 | ✅ | 拖动即时生效，亮度 +17 可见 |
| 撤销 / 重做 | ✅ | 撤销回到上一状态（+18），重做回到 +17 |
| 直方图 | ✅ | 画面左下角显示亮度分布 |
| 预设面板 | ✅ | 10 个预设正常渲染 |
| 真实 USB 联机 | ✅ | `state=ready`，模型 ILCE-7M2 |
| **实时取景** | ✅ | `0x1009 @ 0xFFFFC002` → 124KB/帧、10fps，画面正常显示 |
| 远程快门 | ✅ 动作 | `0x9207 @ 0xD2C2 (2→1)` 被接受 |
| 拍完回传 | ❌ | `0xFFFFC001` 返回空数据；按设计提示「照片留在相机卡」 |
| 缩略图 | ✅ | 设置 → 诊断显示 7/7 张；新拍照片 thumb.ok 4.8KB |
| 按快门后取景是否继续 | ✅ | CAPTURE_UNSUPPORTED 后 state=ready 并自动 startLiveView，帧率维持 ~9.9fps |

### 本轮发现并修复的真机缺陷

| 编号 | 现象 | 根因 | 修复 |
|---|---|---|---|
| D12 | 取景已经出帧，界面仍显示「本机型不支持 USB 实时取景」 | `caps.liveView` 取自 DeviceInfo 的能力位，而 A7M2 的 properties=0 | 以原生 `liveViewSupported` 为准 |
| D13 | 按完快门取景直接停，界面报联机错误 | 取景线程每 10 帧调 `pollCapturedJpeg()`，无新图时抛 CAPTURE_UNSUPPORTED，被当成联机失败 | 新增 `captureInProgress`，取景轮询安静返回 |
| D14 | 冷启动一张缩略图都不补 | 筛选只比对 thumbUri 是否等于原图，漏掉「thumbUri 指向已失效文件」的旧数据 | 同时检查文件是否存在 |

## 8. 原生解析器的本地测试通道（v0.1.3）

Android 模块里真正"容易错"的部分是解析：PTP 容器、Sony 属性数组、对象载荷、曝光解码。
这些都不 import `android.*`，所以不必等十几分钟的 Gradle 构建：

```powershell
pwsh scripts/test-kotlin.ps1     # kotlinc + JUnit，54 个用例，约 3 秒
```

依赖（本机 `_work/`，不入库）：`kotlin-compiler-2.1.0`、`junit-4.13.2`、`hamcrest-core-1.3`、JDK 17。

这条通道第一次跑就抓到 4 个失败，其中一个是**真 bug**：

| 编号 | 现象 | 根因 | 修复 |
|---|---|---|---|
| D15 | `parseSonyVendorCodes` 遇到 `count=0x7FFFFFFF` 直接 `OutOfMemoryError` | 边界检查 `offset + count * 2` 用 Int 计算，`count*2` 溢出成负数后"通过"了检查，随后 `ArrayList(count)` 分配 2G | 改用 Long 比较，并加 512 条上限 |

另外 3 个失败是测试自己的构造有误（声明 1 条却给了半条、用未知 DataType 却让 helper 去编码），
改成显式构造字节后通过。

APK 工作流里也加了 `:expo-sony-camera:test`（聚合任务，不随 AGP 改名的变体后缀任务走），
CI 每次构建都会跑同一批用例。

## 9. 回传提速与拍完预览（v0.1.4）

用户反馈「回传很慢，且希望在回传后自动播放预览」。逐段量了一下，慢的不是 USB 本身：

| 环节 | 之前 | 现在 | 说明 |
|---|---|---|---|
| 落盘前拿宽高 | `BitmapFactory.decodeByteArray` 整张解码（24MP → ~100ms + 96MB 分配） | `inJustDecodeBounds` 只读文件头，几毫秒 | 只是要尺寸，没理由解像素 |
| 缓存 → `ingest/` | `bytes()` 读进 JS 再 `write()` 写回（两次 5MB 拷贝） | `File.move()`（同分区 rename） | 不占 JS 堆 |
| 机身快门等待 | 收到 `0xC201` 后固定等 400ms 再读 | 120ms 首试，不完整再 300/700ms 退避 | 相机多数时候已写完；半截字节用 EOI 判断后重读 |
| 拍后缩略图 | 和预览图同时抢解码 | 等预览放完再生成 | 首帧更快出来 |

- 完整性判断放在 `SonyPtpCodec.isCompleteJpeg`（纯 Kotlin，有 3 个本地用例）：SOI 开头 + 尾部窗口内 `FF D9`。
  不做这一步的话，把首试从 400ms 降到 120ms 会有"落一张半截 JPEG"的风险——它照样能读出宽高，只是图坏了。
- 拍完预览：`ingestPhoto` 落库后写 `capturePreview`，根布局最外层的 `CapturePreviewOverlay` 全屏展示
  `settings.previewSeconds` 秒（0/2/3/5/10，默认 3，0 = 关闭），轻点提前关。挂在根布局是因为
  **机身快门在用户手上，按快门时 App 可能停在任意一页**，只在取景页做会漏掉一半场景。
- 校验：`tests/capture-preview.test.ts` 6 个用例锁住"0 必须是合法值""档位之间取最近""null/undefined 回落默认"。

### 9.1 踩到的坑：USB 读块不能超过 64KB（已回退）

为了少几次往返，试过把单次 bulk-IN 从 64KB 提到 256KB。结果**取景直接死掉**，真机日志（OPPO Pad 4 Pro，ILCE-7M2）：

```
PTP send op=0x1009 tx=18 params=0xFFFFC002
USB bulk-IN retry=1 result=-1 requested=105984 remaining=105984   ← 13ms 返回,不是 5s 超时
retry=2..5 全 -1,clear-halt 也无效
USB bulk-OUT failed op=0x9205 tx=20 result=-1 at=0/16              ← 之后连写都失败
```

判读要点：

- `result=-1` 在**十几毫秒**内返回，说明是 URB 被主控/驱动拒掉，不是设备没数据（超时是 5s）。
- 失败请求都是 >64KB 的；同样时刻 512 字节的容器头、1118 字节的属性读全部正常。
- 换回 64KB 后同一条链路连推 193 帧稳定（v0.1.3 与 v0.1.4 各验证一次）。
- 偶发性：256KB 那次也曾先成功读了 4 帧再死，所以**不能**用"偶尔能跑"来验收。

结论：`MAX_USB_READ_BYTES` 固定 64KB，并在常量处写明原因。一次 4.7MB 回传约七十次往返、
实测 160~200ms，没必要为这点时间赌整条链路。

### 9.2 机身快门取不到图：取景空转 + 事件可能不来（v0.1.6）

用户报「相机上按快门没反应」。真机日志（0.1.5）里两个独立问题：

1. **取景空转**：相机忙/不给取景时回 `0x200F AccessDenied`，而帧循环按 10Hz 无脑重试，
   几分钟堆了几千条事务。期间相机连 `ObjectAdded` 都不发。
   改法：读不到帧就退避（300/600/1000ms），连续 20 次（约 17 秒）仍无帧就停流并给出提示，
   把相机让出来，而不是一直怼着它。
2. **只等事件会漏**：机身快门那张是靠 `0xC201` 通知的，事件丢了就永远取不到。
   改法：监听线程在“没有待取句柄”时每隔约 1 秒兜底读一次 `D215 ObjectInMemory`，
   一旦 `>= 0x8000` 就按机身快门那张取回（3 秒冷却，避免连取同一张）。
   App 自己的快门路径仍在 `state == "capturing"` 时完全屏蔽这条兜底。

仍待验证的边界：如果机身把照片**只写到卡里、不进内存缓存**（D215 永远是 0），
这条兜底也拿不到，需要走卡侧枚举（`0x923B/0x923D` 或标准 `0x1007/0x1009`）。
该分支是否必要，取决于用户下次按机身快门时 D215 是否变化。

### 9.3 一次机身快门出现两张 jpg：RAW+JPEG 时同一个句柄会先后给两个对象（v0.1.7）

真机（0.1.6，机身画质设为 RAW+JPEG）按一次快门，图库里出现两张：

```
23:18:38.963 body shutter: object FFFFC001 announced; fetching
23:18:40.093 object info handle=FFFFC001 format=0x3801 bytes=4176676   name=DSC00001.JPG
23:18:40.286 captured JPEG persisted bytes=4176676                     ← 正确的那张
23:18:41.112 body shutter fallback: D215=0x8001 but no ObjectAdded; fetching
23:18:41.306 object info handle=FFFFC001 format=0xB101 bytes=24734976  name=DSC00001.ARW
23:18:44.110 captured JPEG persisted bytes=24734976                    ← ARW 被存成 .jpg
```

两个原因，都是我们的：

1. **`D215` 不会因为读走而清掉**：照片取回后它仍是 `0x8001`。兜底通道按"有货就取"判断，
   于是事件通道刚取完 JPEG，1 秒后又取了第二次。改成**边沿触发**——只有 `D215` 从 <0x8000
   跨到 >=0x8000 时才取；并且任何一次机身取图后都刷新冷却时间。
2. **RAW+JPEG 时同一个句柄上先放 JPEG、读走再放 ARW**（`format=0x3801` → `0xB101`）。
   ARW 里有嵌入的 JPEG 预览，所以它也能被 `BitmapFactory` 读出尺寸（实测 1616×1080），
   于是一路存成 `.jpg`。现在落盘前一定先看 `0x1008` 的 `format`：不是 JPEG 就跳过并给出
   "相机这一张回传的是 RAW(ARW)" 的提示。
   `captureStill()` 里"清掉内存旧片"的那一步同样先看格式——旧片是 ARW 时不再白读 24MB（省 1.2 秒）。

顺带：完整性判断的尾部窗口从 64B 放宽到 4KB（容忍机身补字节），并去掉"不完整也留着落盘"的兜底，
半截 JPEG 不再进图库。

### 9.4 照片保存位置做成设置项（v0.1.8）

用户问「为什么相机相册里找不到联机拍的照片」。答案是我们自己写的：

```
23:26:12.299 PTP send op=0x9205 tx=9 params=0x0000D222
23:26:12.315 restored D222 capture target to 0x0011      ← 每次联机都写 17
```

`0xD222 拍摄目标` 决定照片存哪儿，相机枚举只有 `[1, 17, 16]`。写 17（出厂默认）时照片只交给主机，
卡里不留，所以相机回放看不到。现在改成设置项：

| 设置项 | 写入 `0xD222` | 预期行为 |
|---|---|---|
| 仅平板（默认） | 17 | 只回传到 App，相机卡里不留 |
| 两边都存 | 1 | 回传到 App，同时写卡（需真机确认） |
| 仅存储卡 | 16 | 只写卡，App 可能取不到照片 |

- 实现：`SonyCameraModule.setCaptureTarget(value)` → `SonyCameraController.setCaptureTargetBlocking()`
  → `SonyPtpTransport.setCaptureTarget()`（`0x9205(0xD222)`，非合法值自动回落到 17，绝不写野值）。
  联机成功后应用一次；设置里改动时立刻写给相机。
- 校验：`tests/capture-target.test.ts` 5 个用例锁住"只允许 1/16/17""非法值回落默认"。
- 待真机确认：1 和 16 分别对应哪种行为（相机枚举没给名字），确认后更新上表和 README。

**结论（v0.1.9 真机实测）：三个值都不写卡。**

用户把三档都试了一遍，相机存储卡里始终没有新照片；每次写入相机都回 `0x2001`（接受），但行为不变。
说明 A7M2 在 USB「PC 遥控」模式下"照片只进内存缓存、直接交给主机"是固件行为，`0xD222` 不控制它，
相机菜单里也没有「保存影像 / Save Media」这一项（A7R II 之后的机身才有）。
因此设置项标题改为「照片保存位置（部分机型有效）」，并在下文写明 A7M2 无效，保留该项给支持的机型。

### 9.5 第二张假图来自「取景期轮询」而不是兜底（v0.1.9）

0.1.7/0.1.8 只给"机身快门"和"清旧片"加了格式判断，App 自己按快门时仍会多存一张：

```
00:27:57.050 captured JPEG persisted bytes=24786176    ← 取景线程的 pollCapturedJpeg 取了 ARW
00:27:57.518 object info handle=FFFFC001 format=0x3801 bytes=4876839 name=DSC00767.JPG
00:27:57.755 captured JPEG persisted bytes=4876839     ← 事件通道拿到真正的 JPEG
```

原因：App 快门这条路上有**两个取图者** —— 取景线程里的 `pollCapturedJpeg()`（每 10 帧查一次
`D215`）和 `awaitCapturedJpeg()`。前者在相机把新照片写进缓存之前先看到旧的 ARW（`D215` 还是
`0x8001`），直接读走并落盘。格式判断只做在机身快门那条路上，所以没拦住。

改法：把格式判断放进 `getObjectPayload()` 本身 —— 所有取图路径（App 快门、取景期轮询、
机身快门、清旧片）都经过它，非 JPEG 一律返回 null，这一次事务就废掉，等新对象出现再取。

（**注意**：这个"直接返回 null"的写法本身有问题 —— 见 §9.7，非 JPEG 必须读走，否则句柄不前进。）

### 9.6 拍完预览支持「一直」+「编辑 / 关闭 / 详情」按钮栏（v0.2.0）

设置里「拍完自动预览」新增一档「一直」（存 `-1`）：不自动消失，按「关闭」才关，且不画倒计时进度条。
实现要点：`normalizePreviewSeconds` 把 `-1` 当合法值、但不让"取最近档位"把它吸走；
`ingestPhoto` 里 `previewSeconds !== 0` 才弹预览；缩略图在「一直」模式下 3 秒后照常生成，
不会因为预览不关就一直不补图。

预览的交互按系统相册改过一版：**点画面不再关闭预览**，只切换按钮栏显隐；按钮栏是
「编辑 / 关闭 / 详情」，静置 2.6 秒自动隐藏；「编辑」直接跳进对应照片的调色器，
「详情」展开文件名 / 尺寸 / 大小 / 时间。换一张照片时整块组件重挂（key=preview.id）
来重置按钮栏和详情面板，避免在 effect 里 setState。

### 9.7 「跳过非 JPEG」把相机堵死了：必须读走（v0.2.1）

0.1.9 的 `getObjectPayload` 看到非 JPEG 直接 `return null`，结果是**第一张正常、之后每枪卡住**：

```
01:30:26 object info handle=FFFFC001 format=0xB101 bytes=24794368 name=DSC02305.ARW
01:30:26 skip non-JPEG object format=0xB101 (DSC02305.ARW)
01:30:27 ... 每秒重复一次，整整 35 秒直到超时
```

根因：**`0xFFFFC001` 的句柄不会自己前进**。RAW+JPEG 时上一枪读完 JPEG 会留下一张 ARW 挂在句柄上；
不把它读走，相机就永远把这张 ARW 摆在同一个句柄，新拍的 JPEG 根本没机会出现。

改法：非 JPEG 也读走，只是不落盘（`getObjectPayload` → `readObjectPayloadRaw` 读，丢弃，返回 null）。
同样的道理，机身快门那条路遇到 ARW 也要 `fetchObject` 一次，不能只 return。
代价是 RAW+JPEG 模式下每次开拍前要多读一张 24MB 的 ARW（约 1.2 秒）——把相机画质设成 JPEG 就没有这笔开销。

### 9.8 「只有第一枪正常」：非 JPEG 要读走，还要继续读下一个对象（v0.2.2）

0.2.1 补上了"读走非 JPEG"，但**机身快门那条路**是"发现非 JPEG → 读走 → 直接 return"。
于是新照片的 `0xC201` 来了、句柄先给上一枪残留的 ARW、读完就结束，后面真正的 JPEG 没人取。
表现就是用户报的：**第一枪正常，之后每枪都没有预览**。

改法：把"读一次"改成**循环最多 5 次**——非 JPEG 读走（句柄才前进）后 `continue`，
直到拿到完整 JPEG 或次数用完；只有全程都是非 JPEG 时才提示 RAW。
（App 快门那条路由 `awaitCapturedJpeg` 每 500ms 轮询，本身就会跨过残留，不用改。）

另外确认：预览浮层用 `key=preview.id` 重挂，所以**预览没关的时候新拍的照片会直接顶掉当前这张**，
不需要先关闭预览。

### 9.9 预览支持放大（v0.2.3）

- **双击**：以点击点为中心放大到 2.5 倍，再双击还原（位移 = (屏幕中心 − 点击点) × (倍数 − 1)，
  这样点到的那个位置基本不动）。
- **捏合**：两指距离比例连续缩放，范围 1~4 倍。
- **平移**：放大后单指拖动；位移按"多出来的画面的一半"夹取，不会拖出空白。
- 单指轻点仍只切按钮栏：双击判定用 240ms 窗口，窗口内的第二次点击取消单击动作。
- 缩放状态跟着 `key=preview.id` 一起重建，新照片永远是 1 倍。

实现上没有引入手势库：用 `PanResponder` + `Animated`（`useNativeDriver: false`，因为手势里要
`setValue` 直接改值）。`react-hooks/refs` 这条规则无法区分"渲染期读 ref"和"事件回调里读 ref"，
在文件头显式关掉并注明原因。

### 9.10 返回键 / 回传画质 / 编辑面板间距（v0.2.4）

- **返回键只退预览**：`PreviewStage` 挂 `BackHandler`，返回 true 消费掉；不然因为预览在根布局
  最外层，按返回会一路退到桌面。
- **回传画质**：设置里新增「JPEG / RAW / JPEG+RAW」，写相机 `0xD253 CompressionSetting`（UINT8，
  1 = RAW / 2 = RAW+JPEG / 3 = JPEG，取值来自 libgphoto2 的 `sony_300_compression` 表，
  "Sony 300" 就是 SDIO 协议 `0x012C`）。ILCE-7M2 的属性数组里没有 D253，写入会被拒，
  这时原生返回 `supported=false`，App 弹提示让用户去相机菜单改 —— 不假装成功。
- **编辑面板间距**：真机 dump 量到「光/色/HSL…」标签条高 **341px（130dp）**，而内容只有 78px：
  横向 `ScrollView` 放在 flex 列里会被拉满剩余高度，于是标签条和参数之间空出一大截。
  给标签条加 `style={{ flexGrow: 0, flexShrink: 0 }}` 后按内容高度收住，同时把分组栏的
  `marginTop` 从 8dp 收到 4dp、参数列表不再额外留白。

### 9.11 免相机自测发现并修掉的两个界面问题（v0.2.5）

- **未连接时却显示「演示模式」徽章**：`IDLE_SNAPSHOT.mode` 默认是 `demo`，首页照搬就成了
  "未连接 + 演示模式"。现在只在已连接/连接中时显示模式徽章。
- **多选状态会跨 tab 保留**：图库里选了 2 张、切到别的 tab 再回来，仍是"已选 2 张"，
  很容易在下一次误操作里把这两张一起删掉。现在用 `useFocusEffect` 在离开图库时清空选择。
- 同时确认了 `TabStrip` 修复的效果：真机上标签条与「N 项」之间的间距从 **296px 收到 34px**，
  曲线面板也不再压住底部按钮（画布 2590-3020，提示行 3020，按钮 3110）。

### 9.12 编辑面板可拖动改大小 + 横屏右置（v0.2.6）

用户要求：编辑面板能自由拉伸；横屏时面板放到右边，也能拉伸。

- 面板大小改成**占长边的比例**（`panelFraction`，默认 0.46，夹取 0.26~0.78）：
  竖屏按高度、横屏按宽度换算成像素，旋转屏幕后不用重新拖。
- 分隔条抽成 `src/components/editor/PanelResizer.tsx`：竖屏是横向细条（上下拖改高度），
  横屏是纵向细条（左右拖改宽度），拖动过程中实时生效。
- 画面 + 面板包进 `styles.body`：竖屏 `column`，横屏 `row`，横屏时画面在左、面板在右。
- `app.json` 的 `orientation` 从 `portrait` 改成 `default`，否则设备转横屏时 App 不跟着转，
  右侧布局永远看不到。
- HSL 面板的八色带条也有同样的"横向 ScrollView 被拉满"问题（与 §9.11 的标签条同源），
  一并加了 `flexGrow: 0`。

**真机验收（v0.2.7）**：

| 检查 | 结果 |
|---|---|
| 竖屏：标签条 → 「8 项」间距 | 34px（修复前 296px） |
| 竖屏：色带 → 「红 · 色相」间距 | 57px（修复前约 240px 空白） |
| 竖屏拖分隔条（上移 300px） | 分隔条 y 1273 → **977**，面板变高、8 个滑块全部可见 |
| 横屏布局 | 画面在左、分隔条居中（x 1774-1832）、参数栏在右 |
| 横屏拖分隔条（左移 400px） | 分隔条 x 1774 → **1372**，参数栏变宽 |
| 旋转后 | 比例沿用，不用重新拖 |

**踩到的坑**：第一版把 `fraction` 放进了 `PanResponder` 的 `useMemo` 依赖，每次 onChange 都重建
responder，手势中途换 handler 导致后续 move 事件丢失 —— 真机表现是"拖 400px 只涨 17px"。
改成把起始值放 ref（用 effect 同步），responder 只依赖方向/长边/上下限，一次手势由一个 responder 处理完。

### 9.13 每个参数都能手填数值（v0.2.8）

用户要求：修图的每个数据可以手动填写。滑块的精度和手感都不适合"就要 +17"这种诉求。

- `ParamRow` 的数值从"点一下归零"改成**点一下进入输入态**：`TextInput`（数字键盘、预填当前值、
  自动全选），回车或失焦提交；提交时夹到 `[min,max]` 并按 `step` 对齐（`step<1` 保留一位小数），
  走 `onCommit` 所以进撤销历史。
- **长按数值**仍然是"归零"（原来的单点行为），两种操作都不丢。
- 空输入按"取消"处理，不会悄悄变成 0。
- 所有滑块都走 `ParamRow`，所以调色六组和 HSL 八色带全部覆盖到；面板底部提示文案同步改成
  「点右侧数值可直接输入，长按归零」。

**真机验收（0.2.8）**：点「亮度」数值 → 弹出数字键盘且内容全选 → 输入 `17` 回车 → 数值显示 `+17`
且滑块跟着移动 → 撤销回 `0` → 输入 `999` 被夹到 `+100` → 输入 `-30` 正常得到 `-30`。


