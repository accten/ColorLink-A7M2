# ColorLink

把索尼 A7M2（ILCE-7M2）变成一台**手机监视器 + 调色台**：USB 连上手机，实时取景、按一次快门自动收一张照片，
在手机上做手动调色 / LUT / 自然语言 AI 调色，结果另存并导出相册。

**只调色，不做美颜**——没有磨皮、瘦脸、滤镜贴纸，只有亮度、对比、色温、高光阴影、颗粒、暗角这些摄影参数。

> 现在的版本可以直接安装试用：**演示模式**会模拟相机推流与快门，把 6 张代码生成的示例图
> （暮色/晨光/夜蓝/肤色/苔原/色卡）当作相机回传走完整链路——取景、一拍一传、调色、导出全都能跑通。
> 真机 USB 联机需要额外接入原生模块，见文末「进阶」。

---

## 功能

| 功能 | 说明 |
|---|---|
| 联机取景 | 画面全屏、保持相机比例、可切三分线、轻点 1.8× 放大；演示模式为轮播帧 |
| 一拍一传 | 快门后自动落盘到 App 私有目录，按 SHA-256 去重，失败自动重试 |
| 拍完预览 | 照片回传完成后全屏展示（默认 3 秒，可设 0/2/3/5/10 秒或关闭），轻点提前关掉 |
| 机身快门回传 | 直接用**相机上的快门按钮**拍，照片也会自动传回平板（相机通过 `ObjectAdded` 事件通知，App 侧 `0x1008 → 0x1009` 取回，取景自动暂停/恢复） |
| 手动调色 | 亮度 / 对比度 / 高光 / 阴影 / 白场 / 黑场 / 褪色 / 去雾 / 饱和 / 自然饱和 / 色相 / 色温 / 色调 / 分离色调 / **HSL 八色相** / 锐化 / 清晰度 / 降噪 / 颗粒 / 暗角 / **色调曲线**，GPU 实时预览；支持撤销/重做、按组重置、亮度直方图 |
| 预设与复用 | 内置 10 个：原图、胶片、电影感、清透、暖调、黑白、人像、高反差、夜景、冷调；支持「复制调色 → 粘贴到本张或一批照片」 |
| 3D LUT | 导入 `.cube`（17/32/33/64），可调浓度，坏文件给出明确原因 |
| AI 调色 | 一句自然语言 → 任意 **OpenAI 兼容**供应商返回结构化参数 JSON → 本地渲染；失败保留原参数。**请求地址、供应商、模型都可在设置里改**，内置 19 家常用供应商（含 DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenRouter、火山方舟、OpenAI、Azure、Ollama 本地等），带「测试连接」 |
| 保存导出 | 另存为 `原名_edited_时间戳.jpg`；尺寸可选「原图 / 2048 / 3000 / 4000 / 6000」，质量可到 100；**没做调色时选「原图 + 100」直接复制原图字节，不重编码**；原图 SHA-256 前后校验；可一键写进系统相册 |
| 图库 | 三列网格、倒序、点开编辑；长按进入多选（删除需确认，不影响相机内文件） |
| 批量编辑 | 选中多张后可批量套预设 / 粘贴同一套调色 / 重置 / 导出（带进度、可取消剩余）/ 删除；**编辑状态自动保存**，退出 App 再进来还在 |
| 秒开编辑 | 入库时一次性生成 480px 缩略图 + 1600px 预览图（只解码一次），编辑页只读预览图，不再解 24MP 原图 |
| 诊断 | 事件日志（自动脱敏，不含 API Key 与图像数据），可导出为文件 |

## 环境要求

- **手机**：Android 10+，arm64（当前 APK 只含 `arm64-v8a`）
- **相机**（真机联机时）：A7M2 固件更新到最新，USB 连接模式设为「PC 遥控」，配支持数据传输的 OTG 线/转接头
- **AI 调色**（可选）：任意一家 OpenAI 兼容供应商的 API Key；默认 DeepSeek（[platform.deepseek.com](https://platform.deepseek.com/api_keys)）。除 AI 调色外，其余功能完全离线

## 安装

### 方式一：下载发行版（推荐）

打开 **[Releases](https://github.com/accten/ColorLink-A7M2/releases)**，在最新版本里下载 `app-release.apk`，
传到手机上安装（首次需允许「安装未知来源应用」）；也可以：

```bash
adb install -r app-release.apk
```

发行版由推 `v*` tag 自动构建并附在 Release 里，是**匿名可下载**的正式入口。

### 方式二：Actions 里的构建产物（每次提交都有）

每次推送到 `main` 都会构建一次，产物在
[Actions → Android APK](https://github.com/accten/ColorLink-A7M2/actions/workflows/android-apk.yml)
的 Artifacts（`colorlink-apk`）里。它需要登录 GitHub、保留 30 天、下载后要解压——
适合想看最新提交的人，日常安装用 Releases 就行。

### 方式三：从源码构建

```bash
npm install
npx expo prebuild --platform android
npx expo run:android          # 装到已连接的手机
```

需要 JDK 17 + Android SDK。Expo Go 跑不了（Skia / SecureStore / MediaLibrary 都是原生模块，必须是 development build）。

## 开始使用

### 1. 连接

首次启动会自动连上「演示相机」，首页能看到 `ILCE-7M2 / 演示模式 / 已连接`、电量与存储占位、最近接收的照片。

想手动切换：点「使用演示模式」重新连接，或点「连接相机」走 USB（当前构建未接入原生模块时会明确提示原因，而不是假装成功）。

### 2. 取景

点「进入取景」：画面全屏，顶部是 LIVE / 帧率 / 电量，右上角可切换三分线，轻点画面 1.8× 放大。
底部左侧「结束」退出，中间是快门，右侧直达图库。快门后照片会出现在「最近接收」里。

照片回到平板后会自动全屏展示几秒（时长在设置里改），轻点即可提前关掉；
按**相机上的快门**拍照走的是同一条路径，同样会回传并预览。

**RAW + JPEG（和像素蛋糕一样）**：相机画质设成 `RAW & JPEG` 时，一次快门的两张都会传回平板——
先到 JPEG（用来预览/调色），紧接着自动再取一次 RAW 原文件。真机实测一张 24.9MB 的 `.ARW`
约 1.3 秒读完，落盘后在图库单独一格，带 `RAW` 角标。同一张的 JPEG / ARW 文件名不同
（各自按接收顺序编号），靠时间与 `RAW` 角标区分。

**RAW 也能修图**：点开 `RAW` 那一格，App 会先用 LibRaw 把 ARW 解成全幅图片
（6000×4000、机身白平衡 + AHD 去马赛克 + sRGB），再进和 JPEG 完全一样的调色器——
参数、曲线、LUT、AI、导出都照常，导出保持原尺寸。解码只在第一次打开时做一次
（平板实测一张 24MP 约 8 秒，一次性成本：AHD 去马赛克在 ARM 上就是这个量级），解好的图缓存在 App 私有目录，之后秒开；
ARW 原件自始至终不改动。

画面下方那排 **快门 / 光圈 / ISO / EV / 白平衡** 是**只读**的，值由相机自己上报（每 2 秒刷新一次）；
参数在相机上改，手机只负责显示。相机没上报或读不到时显示 `—`，不会影响取景和快门。

### 3. 图库

底部 Tab「图库」：三列方格，有调色的照片下方显示摘要（参数摘要 / 曲线 / LUT）。
点开进入编辑器——从第二次起是秒开，因为入库时已经生成好 1600px 预览图。

**批量编辑**：长按任意一张进入多选（或点右上角「选择」），然后：
「预设」一键套给选中的全部、「粘贴调色」把编辑器里复制的调色铺给一批、
「重置」还原、「导出」批量导出（有进度条，可随时取消剩余）、「删除」批量删。
编辑状态会自动保存，退出 App 再进来调整还在。
批量导出会跳过 RAW 那一格并在通知里说明「RAW(ARW) 原文件不支持调色导出」——
一次快门的 JPEG 和 RAW 都在图库里，全选导出不会因为 RAW 整片失败。

### 4. 调色

编辑器下半部分有三个面板：

- **调色**：六个分组——「光 / 色 / HSL / 曲线 / 细节 / 效果」，拖动滑块即时预览；
  **点右侧数值可直接手动输入**（回车/失焦生效，超出范围自动夹到上下限），长按数值归零，
  也能「重置本组」；顶栏可撤销 / 重做；画面左下角是亮度直方图
  - **HSL**：先选色带（红 / 橙 / 黄 / 绿 / 青 / 蓝 / 紫 / 品红），再调该色带的 色相 / 饱和 / 明度
  - **曲线**：RGB 主曲线 + R / G / B 单通道；拖动控制点调整，点空白处加一个点，「重置」还原
- **预设**：10 个内置风格一键套用；支持「复制调色 / 粘贴调色」；下面可导入 `.cube` LUT 并调浓度
- **AI**：输入「调成胶片感，偏暖」「天空更蓝一点」这类指令，或点下方示例。
  面板底部会显示当前供应商与模型；图片只发给你在设置里选的那一家

左上角「保存」直接写出新文件；右上角「按住对比」随时和原图核对（用的是预览图，不会卡）。
面板底部「保存到相册」会额外写入系统相册，并在通知里告诉你文件名。

### 5. 设置

- **AI 调色**：供应商、请求地址、模型、API Key 都可改。
  点「供应商」会列出常用家的**名称 + 请求地址 + 默认模型**，选中即带出；也可以选「自定义（OpenAI 兼容）」
  填自己的网关地址。地址支持 `https://host/v1`、完整的 `/chat/completions`、以及不带协议头的写法
  （本地 `127.0.0.1:11434/v1` 会自动用 `http`）。
  - Key **按供应商分开存**，切换供应商不用重新粘贴
  - 「测试连接」会先试 `GET /models`，再发一条 1 token 请求；失败原因（401/404/超时）直接显示在通知里
  - 本机/局域网地址（Ollama、LM Studio）可以完全不填 Key
- **拍摄**：拍完自动预览时长，0（关闭）/ 2 / 3 / 5 / 10 秒 / **一直**，默认 3 秒。
  预览时**点画面不关闭**，只切换按钮栏显隐（静置 2.6 秒自动隐藏）；
  按钮栏是「编辑 / 关闭 / 详情」：编辑直接进调色器，详情看文件名 / 尺寸 / 大小 / 时间。
  **双击画面放大到 2.5 倍（再双击还原）**，捏合可连续缩放 1~4 倍，放大后单指拖动平移；
  按系统返回键只退出预览，不会退出 App
- **导出**：长边「原图」/ 2048 / 3000 / 4000 / 6000（默认 4000）；JPEG 质量 80 / 90 / 95 / 100（原图）。
  选「原图 + 100」且没有做任何调色时，导出会直接复制原图字节，画质与原图完全一致
- **相机**：照片保存位置「仅平板 / 两边都存 / 仅存储卡」（**部分机型有效**：实测 A7M2 在 PC 遥控模式下三个值都不写卡）；
  **回传画质「JPEG / RAW / JPEG+RAW」**（写相机 `0xD253`，A7M2 不支持时会在通知里说明，去相机菜单改）；
  是否启动时自动连演示相机；USB 模块状态；协议信息
- **诊断**：查看最近事件、导出日志文件

## AI 供应商

全部走 OpenAI 兼容的 `POST {base}/chat/completions`（图片以 data URL 放在 `image_url` 里）。
App 内置下表，选中即带出请求地址与默认模型，仍可手动改；模型名会随各家迭代变化，以控制台为准。

| 名称 | 请求地址（base） | 默认模型 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max-latest` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash` |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash` |
| 火山方舟（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | 接入点 ID（`ep-...`） |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-vision` |
| 百度千帆 | `https://qianfan.baidubce.com/v2` | `ernie-4.5-turbo-vl` |
| MiniMax | `https://api.minimax.chat/v1` | `MiniMax-VL-01` |
| 阶跃星辰 StepFun | `https://api.stepfun.com/v1` | `step-1v-8k` |
| Groq | `https://api.groq.com/openai/v1` | `meta-llama/llama-4-scout-17b-16e-instruct` |
| xAI Grok | `https://api.x.ai/v1` | `grok-2-vision-1212` |
| Mistral | `https://api.mistral.ai/v1` | `pixtral-12b-2409` |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo` |
| Azure OpenAI | `https://<资源>.openai.azure.com/openai/deployments/<部署名>/chat/completions?api-version=2024-10-21` | 部署名 |
| Ollama（本地） | `http://127.0.0.1:11434/v1` | `qwen2.5vl:7b` |
| LM Studio（本地） | `http://127.0.0.1:1234/v1` | 加载的模型名 |
| 自定义 | 任意 OpenAI 兼容地址（自建网关 / one-api / new-api） | 自填 |

注意：

- 模型必须支持**图片输入**，否则供应商会直接拒绝；不支持 `response_format=json_object` 的会由客户端自动降级重试。
- 本地地址（`127.0.0.1` / `localhost` / `192.168.*` / `10.*` / `172.16-31.*`）可以不填 Key；手机连电脑上的 Ollama 要把 `127.0.0.1` 换成电脑的局域网 IP。
- 请求只发送一张 1600px 预览图（不是 24MP 原图），超限时会在本地就拦下并提示。

## 现在还不能做的

- **A7M2 的 USB 取景 / 自动回传**：原生模块已接入（`expo-sony-camera`，收在 `packages/sony-camera`），联机、实时取景（真机 10fps）、远程快门、有线取图、机身快门回传均已在真机验证；相机侧建议把对焦设成 MF（AF 合不了焦时 A7M2 不会开火）。实测记录见 `docs/compatibility-report.md`，协议细节见 `docs/re-sony-ptp.md`
- **联机拍的照片只在平板**：A7M2 在 USB「PC 遥控」模式下不往存储卡写照片（实测三个 `0xD222` 值都一样），
  相机回放里看不到联机期间拍的；要留档请用 App 的「保存到相册」/ 导出
- **峰值对焦**：A7M2 的 PTP 不提供该数据，改为「按住对比 / 放大查看」
- **视频 / 多机位**：不在当前范围；RAW 只在 A7M2 这类机身验证过（解码器是 LibRaw，
  理论上支持它列出的所有 RAW 格式，但 App 只对接索尼这条链路）

## 隐私

- API Key 只存在 Android Keystore 支撑的安全存储里，日志与构建产物里都不会出现；不同供应商的 Key 互不覆盖
- 除 AI 调色会把一张 1600px 预览图发给你配置的供应商外，照片不会离开手机
- 日志只记录事件、耗时、错误码，不记录 Key、也不记录完整图像数据

## 从源码验证

```bash
npm run typecheck   # TypeScript strict，0 error
npm run lint        # ESLint（含 react-hooks 规则）
npm test            # 206 个纯逻辑用例：参数校验 / 曲线 / LUT / AI 解析 / 供应商与地址 / 会话 / 批量导出 / 着色器契约
node scripts/check-sksl.mjs   # 用 CanvasKit 真跑一遍着色器，和 CPU 参考实现逐像素对比
```

`check-sksl.mjs` 会抓字符串单测抓不到的问题：uniform 顺序错位、着色器编译失败、参数语义写反。
改完着色器（`src/features/grading/shader.ts`）建议跑一次。

界面是深色单主题，设计令牌在 `src/design/tokens.ts`；想先看视觉效果可以浏览器直接打开 `design-preview.html`。

## 进阶文档

- `docs/testing.md` — 装好之后的自测清单：五轮、约 20 分钟，带预期结果与排查方式
- `docs/ci.md` — GitHub Actions 出包、正式签名（keystore + Secrets）、常见构建失败
- `docs/sony-transport.md` — 接入真机 USB 联机：模块安装、wrapper、A7M2 需要打的补丁

## License

MIT
