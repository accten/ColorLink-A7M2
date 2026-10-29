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


