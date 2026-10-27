# 真机 USB 联机（已落地的实现与后续打法）

这套接入已经落到代码里了：`src/services/camera/sony.ts` 是真机 transport，`src/services/camera/usb.ts`
在有原生模块时直接用它，取景页在 USB 模式挂原生 `SonyCameraView`。

模块本身 vendor 在 `packages/sony-camera`（根 `package.json` 用 `file:` 引用），上游版本 0.2.1、MIT。
**vendor 的原因和唯一的改动**记在 `packages/sony-camera/VENDORED.md`：上游用 `implementation files('libs/xxx.aar')`
引得本地 AAR，AGP 8 构建库模块时会直接失败，必须改成 `flatDir` 仓库写法。

本文保留原有步骤作为"当初是怎么接的 / 要重做时怎么做"的参考。

> 前提：M0 已在 A7M2 上验证过「连接 / 取景 / 拍摄 / 回传」四项（见 `实现方案.md` 第 6 节）。

## 1. 装模块

```bash
# 现在仓库里已经这么做了：vendor 到 packages/sony-camera，然后
"expo-sony-camera": "file:packages/sony-camera"
npm install
npx expo prebuild --platform android   # 有新原生模块后必须重新 prebuild
npx expo run:android
```

如果要从上游重新拉：`npm i expo-sony-camera@0.2.1`，但**必须**同时改掉 `android/build.gradle`
里的本地 AAR 依赖，否则 CI 的 `assembleRelease` 会失败。

`app.json` 的插件数组里加上 `"expo-sony-camera"`（模块自带 config plugin，会注册
USB_DEVICE_ATTACHED intent-filter 与 `android.hardware.usb.host` 特性）。

## 2. 把占位实现替换成真实包装

`src/services/camera/usb.ts` 改成：

```ts
import SonyCamera, { SonyCameraView } from 'expo-sony-camera';

import { CameraError, CameraSnapshot, CapturedPhoto, ICameraTransport, IDLE_SNAPSHOT } from './types';

export class SonyCameraTransport implements ICameraTransport {
  readonly mode = 'usb' as const;

  private snap: CameraSnapshot = { ...IDLE_SNAPSHOT, mode: 'usb' };
  private readonly stateListeners = new Set<(s: CameraSnapshot) => void>();
  private readonly photoListeners = new Set<(p: CapturedPhoto) => void>();

  snapshot() { return this.snap; }
  subscribe(l: (s: CameraSnapshot) => void) { this.stateListeners.add(l); l(this.snap); return () => this.stateListeners.delete(l); }
  onPhoto(l: (p: CapturedPhoto) => void) { this.photoListeners.add(l); return () => this.photoListeners.delete(l); }
  liveFrames() { return []; }   // 真机取景由原生 View 直接上屏

  async connect(): Promise<CameraSnapshot> {
    this.snap = { ...this.snap, phase: 'connecting' };
    try {
      await SonyCamera?.connect();               // PC Remote 会话 + 0x9201 握手
      const state = SonyCamera?.getState();
      this.snap = {
        phase: 'ready',
        mode: 'usb',
        info: { model: state?.model ?? 'ILCE-7M2', firmware: state?.firmware ?? '—', mode: 'usb' },
        caps: { liveView: true, stillCapture: true, imageTransfer: true, deviceProps: true },
      };
    } catch (error) {
      this.snap = { phase: 'error', mode: 'usb', error: toCameraError(error) };
    }
    this.stateListeners.forEach((l) => l(this.snap));
    return this.snap;
  }

  async startLiveView() { await SonyCamera?.startLiveView(); this.patch({ phase: 'live' }); }
  async stopLiveView() { await SonyCamera?.stopLiveView(); this.patch({ phase: 'ready' }); }

  async capture() {
    try {
      await SonyCamera?.capturePhoto();          // S1/S2 按键序列，或 0x100E fallback
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toCameraError(error) };
    }
  }

  async disconnect() { await SonyCamera?.disconnect(); this.snap = { ...IDLE_SNAPSHOT, mode: 'usb' }; }

  private patch(p: Partial<CameraSnapshot>) { this.snap = { ...this.snap, ...p }; this.stateListeners.forEach((l) => l(this.snap)); }
}

export function createUsbTransport(): ICameraTransport { return new SonyCameraTransport(); }
export function isUsbTransportAvailable(): boolean { return true; }
```

> 上面的方法名是 `expo-sony-camera@0.2.1` 的公开面（`connect / getState / startLiveView /
> stopLiveView / capturePhoto / disconnect`）。如果你用的是 fork，以 fork 的
> `build/index.d.ts` 为准 —— 这层包装的意义就是：**模块 API 变了只改这一个文件**。

## 3. 取景页换成原生 View

`app/live.tsx` 里演示模式走 `<Image source={frame}>`，真机要走模块的原生视图：

```tsx
import { SonyCameraView } from 'expo-sony-camera';

{camera.mode === 'usb' ? (
  <SonyCameraView active style={{ width: '100%', height: '100%' }} />
) : (
  <Image source={currentFrame} ... />
)}
```

帧数据**不进 JS**：模块内部把 JPEG 解到原生 View 上，JS 只收 `state / fps / error`。

## 4. 一拍一传

模块在相机快门后通过 `onPhotoCaptured` 事件把 JPEG 交给 JS（或落地成文件）。
我们的落库逻辑已经完全独立，接上即可：

```ts
useEffect(() => SonyCamera?.addListener('onPhotoCaptured', (e) => {
  // e 里通常是 { uri } 或 base64；转成 CapturedPhoto 后交给 store
  void onNativePhoto(e);
}), []);
```

如果模块只给 base64，落盘用：

```ts
const bytes = Uint8Array.from(atob(e.base64), (c) => c.charCodeAt(0));
```

（`CapturedPhoto.hash` 必须填：用 `sha256OfFile()` 算，一拍一传的去重依赖它。）

## 5. 需要为 A7M2 打补丁的三个点

按 `实现方案.md` 2.4 的协议事实表，老机身最可能在这三处与模块现有假设不同：

| 位置 | 现状 | 补丁 |
|---|---|---|
| `prepareLiveView()` | 先轮询 `D221`，非 0 才继续 | A7M2 若不报该属性，改为直接尝试 `GetObjectInfo/GetObject(0xFFFFC002)`，成功即视为就绪 |
| `SonyPtpCodec.parseSonyJpegData` | 假定 `u32(0)` 是 JPEG 偏移 | 放宽为先搜 `FFD8`，找不到再按偏移试 |
| `captureStill()` | `0x9207` + `0xD2C1/0xD2C2` | 失败时 fallback 到 `0x100E InitiateCapture` |

改完把结论写回 `docs/compatibility-report.md`（M0 的交付物）。

## 6. 不要做的事

- **不要**并发发 PTP 命令：一条 USB 会话只能串行，取景和一拍一传必须共用同一队列。
- **不要**在 `D215 < 0x8000` 时去读 `0xFFFFC001`：老固件有崩溃先例。
- **不要**在取景循环里每帧都读全量属性块（`0x9209`）：限频到 100ms 级，否则帧率会被拖死。
- **不要**把相机内文件当成本地文件引用：一律复制进 `ingest/` 再用摘要去重。
