# 参考实现逆向后拿到的 Sony PTP 事实（记录，不复制代码）

> 目的：给 `packages/sony-camera` 里的 Sony 传输层补上 A7 II 这一代的行为差异。
> 来源两条，**互相印证**：
> 1. 本机真机抓的 USB/PTP 追踪（`adb logcat -s ExpoSonyCamera`）；
> 2. 对一个同类 App 的 APK 做静态逆向，读它 **公开可见的协议编排**（操作码、属性码、参数、顺序）。
>    逆向产物只用于互操作，不复制其代码，也不随本项目分发。
>
> 逆向工具与产物都在 `REA (Reverse Engineer Anything)/`（已加入 `.gitignore`，不进仓库）。

## 反编译环境（本机，Windows）

```powershell
# APK -> DEX -> Java（只解需要的 dex，APK 本身 839MB）
jadx --no-res --no-debug-info -j 4 -d decompiled classes5.dex
```

得到的关键包：`com.truesight.cameraptp.ptp`（USB PTP 栈）、`com.truesight.camerawirelesscontrol`（Wi-Fi PTP/IP 原生栈，`libcamerawirelesscontrol.so`）。

真正敏感的字节级编码被抽到 `libCC0000006AA3B68100031FB3A32FD7B1.so`（`CC…vm_void(id, args)` 这种 Java→VM 调用），
所以能读到的是**协议编排与常量**，这正是我们要的部分。

## 操作码（Sony 扩展）

| 名称 | 值 | 说明 |
|---|---|---|
| `SonySDIOConnect` | `0x9201` | SDIO 握手（3 步参数） |
| `SonyGetSDIOGetExtDeviceInfo` | `0x9202` | 取扩展设备信息 |
| `SonyGetDevicePropDesc` | `0x9203` | 属性描述 |
| `SonySetDeviceControlA` | `0x9205` | 按**属性码**写值（如取景尺寸） |
| `SonySetDeviceControlB` | `0x9207` | 按**控制码**发动作（如快门） |
| `SonyGetAllDevicePropData` | `0x9209` | 取全部属性（大块数据） |
| `sonyToggleMtpMode` | `0x9212` | PTP↔MTP 切换 |
| `sonyGetRootDirHandles` | `0x923B` | 根目录对象列表（Sony 自有，不是标准 0x1007） |
| `sonyGetHandlesInfo` | `0x923C` | 句柄信息（含文件名/格式/大小） |
| `sonyGetPartialObject` | `0x923D` | 分块取对象 |
| `sonyGetThumbOrPreview` | `0x923E` | 取缩略图/预览 |

## 属性码

| 名称 | 值 | 备注 |
|---|---|---|
| `SonyObjectInMemory` | `0xD215` | 与本项目原实现一致 |
| `SonyStillImage` | `0xD2C2` | 快门控制码 |
| `SonyStillImageStoreDestination` / `SonyCaptureDestination` | `0xD222` | 存卡/回传目标 |
| `SonyLiveViewSize` | `0xD26A` | 用 `0x9205` 写，2 字节值 |
| `SonyBatteryLevel` | `0xD218` | |
| `SonyAspecRatio` | `0xD211` | |

事件码：`SonyObjectAdded 0xC201`、`SonyObjectRemoved 0xC202`、`SonyPropertyChanged 0xC203`。

## 取景：不靠 D221，直接 GetObject

参考实现的取景动作极简：

```
GetObject(0x1009), param = 0xFFFFC002      // Sony 的"实时取景"虚拟句柄
数据容器解析：跳过 Sony 头，找到 JPEG SOI(FF D8) … EOI(FF D9)
```

> 我们的模块原来先用 `GetObjectInfo(0x1008)` 探 `0xFFFFC002`，再要求 `D221 != 0`。
> A7M2 两条都不满足 → 取景必然失败，而且 `0x1008` 在 A7M2 上会**不回包**（USB 读超时）。
> 参考实现根本不发 `0x1008`。

## 快门：一次控制码，两段数据

```
SetDeviceControlB(0x9207, param = 0xD2C2, data = u16 2)   // 按下
sleep 1000ms
SetDeviceControlB(0x9207, param = 0xD2C2, data = u16 1)   // 释放
```

参考实现**不发 0xD2C1 半按**。我们原来先 `0xD2C1` 再 `0xD2C2`，A7M2 上可能因此停在"半按未释放"。

## 回传：直接 GetObject 虚拟句柄，或用 Sony 自有列表

- 拍完后的取图同样走 `GetObject(0x1009)`，句柄是 Sony 的"已拍图像"虚拟句柄 `0xFFFFC001`（`-16383`）；
- 若要浏览卡内已有照片，用 Sony 自有的一组操作：`0x923B/0x923C/0x923D/0x923E`，
  **不是**标准 PTP 的 `0x1007 GetObjectHandles`；
- 相机还支持 `CameraConnectMode`：`PtpMode` / `MtpMode` / `SwitchablePtpMtpMode`，
  也就是**可以在 PTP 与 MTP 之间切换**（`0x9212`）来读卡 —— 对应 Sony 桌面端"遥控时切 MTP 取图"的做法。

> 我们的模块原来用标准 `0x1007`（还先发 `0x1008`）在 A7M2 上都实测挂死。
> 参考实现的路径完全不同：`0x1009` 直取 + Sony 自有列表操作 + 事件驱动（`0xC201`）。

## 事件：相机自己会说"有新对象"

USB 传输层同时打开 **bulk in / bulk out / interrupt in** 三个端点，
`InterruptEventLoop` 常驻读中断端点，收到 `SonyObjectAdded(0xC201)` 就知道有新图（句柄在事件里），
不需要轮询属性来判断"拍完了没有"。

> 我们的模块只用了两个 bulk 端点，从不读中断端点。

## 对 A7M2 的落地顺序

1. 取景改成 `0x1009 @ 0xFFFFC002`（去掉 `0x1008` 与 `D221` 门禁）；
2. 快门改成 `0x9207 @ 0xD2C2 (2 → 1)`；
3. 回传改成 `0x1009 @ 0xFFFFC001` 直取（不再先 `0x1008`）；
4. 仍不通时再上 Sony 自有列表 `0x923B/0x923C/0x923D`，最后才考虑 `0x9212` 切 MTP；
5. 中断端点事件循环作为增强（实时性更好，也不靠猜）。

## 取图链路（从参考实现的调用关系反推）

参考实现的取图不是标准 PTP，而是 Sony 自有的一组操作，调用顺序如下（类名与字段名都可读）：

```
SonyPtpGetObjectHandlesAction.exec(io):
  cardId = (storageId >> 16) & 0xFFFF          // 0x00010000 → 1
  SonyPtpGetRootDirHandlesCommand(camera, cardId)      // 0x923B(cardId) → 根目录 dir handles
  for (dirHandle in rootHandles):
      SonyPtpGetAllHandles(camera, dirHandle, cardId, visited)   // 单个目录：handle → HandleInfo
      recurse(subdirHandle)                                     // 有子目录就继续
  filterHandlesByFormat(...)                                 // 按 JPEG/ARW/HEIF/视频 过滤
```

`SonyCameraControl.HandleInfo` 的构造参数是 `(name, handle, format, fd?, size, kind)` 这一类，
说明 0x923C 返回的条目里带文件名、大小与格式码；`filterHandlesByFormat` 之后再按句柄取原图：

- `SonyPtpGetImageAction` / `SonyPtpGetPartialObjectCommand`（0x923D）
- 缩略图/预览走 `SonyPtpGetThumbOrPreviewCommand(handle, cardAndFileType, isThumb)`（0x923E）

### 关键更正

之前我们以为 `0x923B` 的参数是完整 storageId（`0x00010000`），**实际是 `storageId >> 16`，也就是 `1`**。
这条来自 `SonyPtpGetObjectHandlesAction.exec` 的第一行，可信度高。

### 仍在 VM 里的部分

`0x923B` / `0x923C` / `0x923D` / `0x923E` 的 `encodeCommand` / `decodeData` 全部被抽进
`libCC0000006AA3B68100031FB3A32FD7B1.so`（`CC…vm_void(id, args)`），所以参数与返回结构在 Java 侧看不到。
我们的做法是：在 App 里内置一个「Sony 协议探测」入口（设置 → 诊断），逐条发操作并打印
返回码 + 前 256 字节 hex，再离线按字节反推结构 —— 比每次改 Kotlin 重新打包快得多。

下一步（待真机探测数据）：

1. `0x923B(1)` 的返回里数出 dir handle 的布局（count + handles？）
2. `0x923C` 的返回里定位文件名/大小/格式/句柄字段
3. 用 `0x923D` 分块读最新一张，落盘后走现有 ingest/调色/导出链路