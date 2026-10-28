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

---

## 决定性证据：Sony 的「拍进内存缓存再回传」路径（有公开参考实现）

像素蛋糕的静态代码只能看到 `0x923B/0x923D` 那套"读卡里已有照片"的路径，
但 A7M2 的**实时回传**其实走的是 Sony 自己另一条更简单的路：把照片拍进相机的
内存缓存，再从虚拟句柄 `0xFFFFC001` 整读。这条路在 libgphoto2 里有完整实现，
而且它明确列了我们的机身：

```
camlibs/ptp2/library.c:
  {"Sony:ILCE-7M2 (Control)", 0x054c, 0x0a6a, PTP_CAP|PTP_CAP_PREVIEW}
  ...
  if (VendorExtensionID == PTP_VENDOR_SONY &&
      ptp_operation_issupported(PTP_OC_SONY_SDIO_ControlDevice /*0x9207*/))
        return camera_sony_capture(...);
```

`0x054c:0x0a6a` 就是我们在真机上看到的 A7M2 USB ID —— 也就是说这条路径不是猜的，
是同一具机身在一个成熟实现里被长期验证过的。

### 联机阶段：`0x9202` 必须按 PTP 3.00 请求

```
0x9201 SDIO_Connect(phase=1, 0, 0)
0x9201 SDIO_Connect(phase=2, 0, 0)
0x9202 SDIO_GetExtDeviceInfo(param1 = 0x012C /*PTP 3.00*/, param2 = 1)   // 可重试，直到有数据
0x9201 SDIO_Connect(phase=3, 0, 0)
0x9205 SetExtDevicePropValue(0xD25A PriorityMode = 1 /*application*/)
```

`0x9202` 的返回体：

```
UINT16   协议版本
AUINT16  设备属性码（UINT32 count + N×UINT16）
AUINT16  控制项码（UINT32 count + N×UINT16）
```

每个码按高 3 位分类：`0x1000` 操作 / `0x4000` 事件 / `0x5000` 属性。
**这就是 A7M2 `DeviceInfo` 里 `properties=0` 的原因**：我们原来传的是 `0x00C8`（PTP 2.00），
机身按 200 回包，扩展清单是空的；改成 `0x012C` 之后，`0xD215 / 0xD213 / 0xD2C1 / 0xD2C2`
这些码才会出现在能力表里。

### 拍照 + 回传：完整序列

```
1) 清缓存：0x1014 GetDevicePropDesc(0xD215)  ≥ 0x8000 时先把 0xFFFFC001 读走丢掉
2) 半按：  0x9207 param=0xD2C1, data=u16 2
3) 全按：  0x9207 param=0xD2C2, data=u16 2
4) 停住：  最多 1s，等 0xC201 事件或 0xD213(FocusFound) ∈ {2,3}
5) 松开：  0x9207 param=0xD2C2 → 1，然后 0xD2C1 → 1
6) 等就绪：轮询 0x1014 GetDevicePropDesc(0xD215)，直到 ≥ 0x8000
7) 取图：  0x1009 GetObject(0xFFFFC001)   // 整读，data 段就是文件字节
```

`0xD215` 只有 `0x1014` 这条读法在 A7M2 上可靠：
`0x9209` 那个 ~1118 字节的属性大容器在这具机身上解不出条目，
而 `0x1014` 逐条问是有回的。

### 我们之前为什么取不到

| 症状 | 真正原因 |
| --- | --- |
| `0x1009 @ 0xFFFFC001` → `0x2001` + 0 字节 | 相机内存里根本没有对象：只发了全按、没发半按，机身也没进"拍摄中"状态 |
| `0x1008 @ 0xFFFFC001` 挂 20s 打死链路 | 同上；对象不存在时访问虚拟句柄，固件直接不回包 |
| `0x101B` 一按下去就断链 | 这台机身不支持分块读虚拟句柄，`0x1009` 整读才是正路 |
| `0xD222 = 1/2` 相机接受但不交图 | `0xD222 CaptureTarget` 的合法取值是 `{1,16,17}`，`2` 是无效值；而且回传根本不靠它 |
| 设备能力表里 `properties=0` | `0x9202` 请求的是 PTP 2.00（`0x00C8`），扩展清单为空 |

> 早期我们据"像素蛋糕不发半按"推断"半按会让 A7M2 卡在半按态"，
> 这条推断是**错的**：正确顺序是先半按再全按、最后按相反顺序松开，缺了前半段就永远没有内存对象。

### 其他

- 回传文件可能是 RAW(ARW)：TIFF 容器里没有 `FF D8`，
  所以取回的数据不能再假设是 JPEG，要按魔数判断（JPEG / ARW 的 `II*\0`）。
- 中止/失败后不要指望机身自己清理缓存：`0xD215` 还在 `0x8000` 以上时下一枪会读到上一张。
