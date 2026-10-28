# 真机兼容性报告：ILCE-7M2 × USB PTP2

这份文档只记录**实测**结论，以及与 `expo-sony-camera` 0.2.1 方言不一致的地方。
每次换机身/换系统版本都应在这里补一行。

## 测试环境

| 项 | 值 |
|---|---|
| 相机 | Sony ILCE-7M2（A7M2），USB 连接模式 = PC 遥控 |
| 手机（第一轮） | OPPO Find X8 Ultra `PKJ110`，Android 17（SDK 36），1440×3168 |
| 平板（第二轮，当前） | OPPO Pad 4 Pro `OPD2409`，Android 16（SDK 36），2400×3392 |
| 连接方式 | USB-C OTG 直连（手机/平板做 USB Host，相机侧 Micro-USB） |
| App | ColorLink 0.1.1（versionCode 2）→ 修复后重测见下文 |
| 采样方式 | `adb logcat -s ExpoSonyCamera`（原生 PTP 追踪）+ 应用事件日志 + `uiautomator` 定位 |

## 1. USB 枚举：通过

`dumpsys usb` 里 host 侧设备描述符：

```
vendor_id=1356 (0x054C Sony)  product_id=2666 (0x0A6A)
manufacturer_name=Sony  product_name=ILCE-7M2  version=2.00
interface: class=6 (Still Image) subclass=1 protocol=1
endpoint: bulk-in 0x81 (512B) / bulk-out 0x02 (512B)
```

模块的 `sony_camera_device_filter.xml` 正是 `vendor-id=1356 class=6`，
所以插上相机时 Android 会按 intent-filter 把 App 拉起来，权限对话框也随之出现
（实测 `permissions_manager` 里 `app.colorlink.a7m2` 的 uid 已持有
`/dev/bus/usb/001/003` 的设备权限）。

## 2. PTP2 握手：通过

原生追踪（节选，全部 `code=0x2001` = OK）：

```
opening PTP transport 054c:0a6a interfaces=[6/1/1:ep3] permission=true
PTP send op=0x1002 params=0x00000001        → 0x2001   (OpenSession)
PTP send op=0x9201 params=1,0,0             → 0x2001   (SDIOConnect)
PTP send op=0x9201 params=2,0,0             → 0x2001
PTP send op=0x9202 params=0x00C8 bytes=86   → 0x2001   (GetExtDeviceInfo, proto 0x00C8)
PTP send op=0x9201 params=3,0,0             → 0x2001
PTP send op=0x1001                          → 0x2001   (GetDeviceInfo)
```

App 侧得到 `state=ready`、`model=ILCE-7M2`，首页显示「已连接 / USB 联机 / ILCE-7M2」。
**结论：A7M2 的 Sony Camera Control PTP2 握手是通的。**

## 3. 实时取景：不支持（机身方言差异）

进入取景后原生追踪：

```
Sony live-view status D221=missing
...
failure SonyPtpException: Sony live view did not become ready (D221=missing).
state=error
stream session=... stopped frames=0
```

`0xD221`（Sony LiveViewStatus）是 A7 III 之后机身的属性；A7M2 的属性列表里没有它，
模块据此判定取景不可用并直接 `fail()` —— 连 PTP 会话一起拆掉。
`frames=0`，取景页是纯黑。

**结论：A7M2 上不要期待 USB 实时取景。** 修复方向是「取景不可用 ≠ 联机失败」：
保留会话，把取景能力标成 false，快门与回传照常。

## 4. 远程快门 + 回传：V1 失败，已改为标准 PTP 兜底

V1 原生追踪：

```
state=capturing message=Capturing on Sony camera…
PTP send op=0x9207 params=0x0000D2C1 → 0x2001   (S1 半按)
PTP send op=0x9207 params=0x0000D2C2 → 0x2001   (S2 全按)
PTP send op=0x9207 params=0x0000D2C2 → 0x2001   (释放)
（随后 30s 内持续轮询 op=0x9209 GetExtDeviceProps，始终等不到 D215）
failure: The camera fired, but no JPEG reached the app.
```

模块用 `0xD215 ObjectInMemory >= 0x8000` 判断「相机已生成新图」并读取虚拟句柄
`0xFFFFC001`。A7M2 根本不报这条属性，于是永远等不到，35s 后超时。

修复（`packages/sony-camera` 内）：没有 `D215` 时退回**标准 PTP**——

1. 按下快门前用 `GetObjectHandles(0x1007, storage=-1, format=0)` 记一份基线；
2. 轮询同一操作，取差集认出「这一张」；
3. `GetObjectInfo(0x1008)` + `GetObject(0x1009)`（大于 8MB 时走 `GetPartialObject(0x101B)`）下载。

同时补了诊断日志：首次读属性时打印机身实际上报的全部 `0xD2xx` 属性码，
后续遇到其它老机身可以直接对照，不用再猜。

## 5. 会话复原：进程内重连会卡死，杀进程可恢复

V1 在取景失败后再点「连接相机」，原生追踪变成：

```
opening PTP transport ... permission=true
PTP send op=0x1002 → （20s 无响应）
USB bulk-IN retry=1..4 result=-1
```

即相机不再应答 `OpenSession`。把 App 进程杀掉再启动，立刻恢复正常：

```
PTP send op=0x1002 → 0x2001
PTP send op=0x9201 params=1,0,0 → 0x2001
```

说明 USB 端口在最后一个文件描述符关闭后才被内核复位。修复后取景失败不再拆会话，
这个坑只在真正的 USB 级错误上才会遇到；遇到时**杀掉 App 重开**即可，
比拔插 USB 线省事。

## 6. 其它发现

- 取景页顶部会把机身名显示两次（`ILCE-7M2 · ILCE-7M2`）：模块的 `firmware` 字段在
  A7M2 上回落到 `productName`，界面 `model · firmware` 就重复了。
- 没接相机时点「连接相机」，`connect()` **不会 reject**，而是正常返回 `disconnected`。
  旧代码把它当成功，界面显示「相机已连接」但取景全黑 —— 已改为只认 `ready/live`。

## 复测清单（每次改完原生模块都跑一遍）

1. 设置 → 「USB 联机模块：已链接」
2. 首页点「连接相机」→ 状态「已连接」，模型 `ILCE-7M2`
3. 首页「取景」显示「不支持」（A7M2 预期值）
4. 点「进入取景」→ 页面给出「本机型不支持 USB 实时取景」，快门仍可按
5. 按「远程快门」→ 相机实际拍一张 → 图库出现新照片，尺寸为相机 JPEG 尺寸
6. 用机身快门拍一张 → App 自动收到并入库（一拍一传）
7. 断开/重连各一次，进程不崩、状态正确

## 7. 按参考实现重写之后的第二版（待实测）

把同类 App 的 USB PTP 栈逆向之后（见 `docs/re-sony-ptp.md`），确认我们前几版的三处做法都与
A7M2 的方言不符，已全部改掉：

| 环节 | 旧实现（实测失败） | 新实现（对照参考实现） |
|---|---|---|
| 取景 | 先 `GetObjectInfo(0x1008)` 探 `0xFFFFC002`，且要求 `D221≠0` | 直接 `GetObject(0x1009)` @ `0xFFFFC002`，无门禁 |
| 快门 | `0xD2C1` 半按 → `0xD2C2` 全按 → 一起释放 | 只发 `0x9207` 参数 `0xD2C2`，数据 `2` → 1s → `1` |
| 回传 | `0x1008` → `0x1009`（虚拟句柄） | 直接 `GetObject(0x1009)` @ `0xFFFFC001` |

`0x1008` 在 A7M2 上不回包，这正是之前"USB 静默 → 必须拔插"的根因；`0x1007 GetObjectHandles`
同样会挂死，也已从代码里删除。

复测清单见上一节，重点看第 4、5、6 项（取景是否出画面、快门是否回传、机身快门是否自动入库）。

## 8. 第二版实测结果（2026-10-28，OPPO Pad 4 Pro + ILCE-7M2）

按 `docs/re-sony-ptp.md` 重写后，在真机上逐项验证：

| 项目 | 结果 | 证据 |
|---|---|---|
| USB 联机 | ✅ | `state=ready`，首页显示「已连接 · ILCE-7M2」 |
| **实时取景** | ✅ **通了** | `PTP send op=0x1009 params=0xFFFFC002` → `code=0x2001 bytes=124148`；`live-view cycle=… jpegBytes=123538`；`stream metrics frames=51 fps=10.05 maxGapMs=139` |
| 远程快门 | ✅ 快门动作被相机接受 | `0x9207 @ 0xD2C2 (2 → 1)` 均返回 `0x2001` |
| 拍完自动回传 | ❌ 仍不可用 | 回传句柄 `0xFFFFC001` 返回 `code=0x2001 bytes=0`（空数据），4 次后按设计报 `CAPTURE_UNSUPPORTED`，会话保留、照片留在相机卡 |
| 原图直出导出 | ✅ | `mode=original`，`bytes=279854`，`ms=5`（直接复制原图字节，未重编码） |
| 原图尺寸 + 调色导出 | ✅ | `mode=graded`，900×600（原尺寸）、q100、`ms=36` |
| 缩略图 | ✅ | 入库后 `thumb.ok`，列表使用 480px 缩略图 |

### 结论与下一步

- **取景已解决**：A7M2 的取景帧就是 `GetObject(0x1009)` 打在 `0xFFFFC002` 上，约 10fps、每帧 ~124KB。
  之前几次失败完全是因为先发 `0x1008`（A7M2 不回包）与 `D221` 门禁。
- **回传仍未解决**：PC 遥控模式下 `0xFFFFC001` 只回空数据。参考实现里对应的做法是
  在 PTP / MTP 之间切换（`0x9212 sonyToggleMtpMode` + `completePtpMtpModeChange` 等事件），
  再走 MTP 的对象列表取图；那条路径的参数是加密的（VM 混淆），需要继续试或抓包。
- 现阶段产品行为：**联机 + 取景 + 远程快门可用，照片存相机卡**；App 会明确提示而不是假装成功。

## 9. v0.1.2 发布前的最终复测（全部真机，2026-10-28）

| 项目 | 结果 | 证据 |
|---|---|---|
| 强停后不拔线直接重连 | ✅ | 先发 `0x1003 CloseSession` → `0x2003 SessionNotOpen`（无害）→ `0x1002` 回 `0x2001` → `state=ready` |
| 实时取景 | ✅ | `stream metrics frames=51 fps=10.07 avgBytes=79576 maxGapMs=124` |
| 快门后会话保留 | ✅ | `capture unsupported by this body; keeping the PTP session alive` → `state=ready`（不再 `fail()`） |
| 快门后取景自动接回 | ✅ | `startLiveView state=ready` → `state=streaming`，随后 `fps=9.88 / 9.97` 持续出帧 |
| 缩略图 | ✅ | 设置 → 诊断显示 `7/7 张`；新拍照片 `thumb.ok 4791 bytes` |

结论：**联机、取景、远程快门、缩略图、导出、调色都在真机上跑通**；
唯一未打通的是 A7M2 的 PTP 照片回传（相机在 PC 遥控模式下不交出图像），已在 UI 与文档中如实标注。

## 10. 有线取图：A7M2 固件层面不支持（三条独立证据）

按参考实现给出的调用链，在真机上逐条试了 Sony 的取图/切换操作（设置 → 诊断 → Sony 协议探测，
带自动重连的一键序列）：

| 操作 | 参数 | 结果 |
|---|---|---|
| `0x923B` 卡内根目录句柄 | `[1]`（cardId = storageId>>16，来自参考实现 `exec` 第一行） | 20.4s 读超时，`USB read could not be recovered` |
| `0x9212` PTP↔MTP 切换 | `[1]` | 20.4s 读超时，同样打断 USB |
| `0x923C` / `0x923E` / `0x923D` | `[1,0]` 等 | 前一条把管线打断后直接 `USB write failed` |

加上更早的两条：

| 操作 | 结果 |
|---|---|
| `0x1007` GetObjectHandles（标准 PTP，带真实 storageId） | 20s 静默，之后 `OpenSession` 回 `0x201E` |
| `0x1008` GetObjectInfo（Sony 虚拟句柄） | 不回包，管线卡死 |

**结论：** A7M2（2014 年固件）的 PC Remote 通道只实现了一个很小的 Sony 子集
（`0x9201/0x9202/0x9205/0x9207/0x9209` + 标准会话/设备信息 + 对虚拟句柄 `0x1009` 取对象）。
参考实现里那套「卡内句柄列表 + MTP 切换」在这台机身上根本没有实现，而且它对未实现的厂商操作
不是回错误码，而是**直接不回包并让 USB 管线失效**，所以每次试探都要重连。

能在 A7M2 上用的只有：联机、取景（`0x1009 @ 0xFFFFC002`，实测 10fps）、远程快门（`0x9207 @ 0xD2C2`）。
照片回传只能走读卡器或相机 Wi-Fi。

如果要做「手机内取图」，可选方向（都绕不开固件限制）：

1. 让用户在相机上把 USB 连接改成 MTP/存储，用 Android MTP 主机实现（libmtp 级别工作量，且此时不能联机取景）
2. 走相机 Wi-Fi（A7 II 时代的 Smart Remote / PlayMemories 私有 API），需要另外逆向下行协议
3. 保持现状：联机 + 监看 + 远程快门，文件用读卡器

## 11. 事件通道：为什么像素蛋糕能"看起来取到图"，以及我们到哪一步

像素蛋糕在 A7M2 上确实把一张 RAW 拉进了内存（真机日志 18:17:39-41：
`loadImage handleCompletion imageComplete`，`Raw:Demosaic/LdBayer`，`maker=SONY model=ILCE-7M2`），
且那次会话里 **USB 没有重新枚举** —— 说明它走的是 PTP 会话内的通道。

它们的 `InterruptEventLoop` 就是干这个的：相机拍完会在**中断端点（0x83）**上推
`ObjectAdded (0xC201)`，参数里带新对象句柄。

我们补上事件读取后，在真机上复现了同一条事件流：

```
event loop started endpoint=0x0083 max=32
PTP event code=0xC203 params=0x0000D21D      // 相机属性变化
PTP event code=0xC201 params=0xFFFFC001      // 按快门后：新对象 = 虚拟回传句柄
PTP event code=0xC202 params=0xFFFFC001      // 随后被移除
```

但**拿到句柄不等于拿到字节**。同一窗口内把四条路径都试了一遍：

| 路径 | 结果 |
|---|---|
| `0x1009 GetObject(0xFFFFC001)` | `code=0x2001 bytes=0`（成功、无数据） |
| `0x101B GetPartialObject(handle,0,64KB)` | **相机直接断链**（`USB write failed`，需要重插） |
| `0x923D [handle,0,64KB,cardInfo]` | 未及执行（上一条已把链路打断） |
| `0x1008 GetObjectInfo(handle)` | 之前实测会挂死 |

同一次会话里还验证了：

- 写 `0xD222`（CaptureDestination / StillImageStoreDestination）= 1 / 2 都被接受（`0x2001`），
  但**并没有让相机把图交出来**；
- `0x923B(1)`、`0x9212(1)`、`0x1007(storageId)` 全部超时并打断 USB。

### 结论

A7M2 这条链路我们已经走到"事件能收、句柄能拿到、但对象没有数据"。
剩下缺的是**让相机把图像真正交给 host 的那一步**（某个属性/命令的确切编码），
它被包在像素蛋糕的 VM（`libCC…so`）里，靠猜参数代价很高 —— 每次猜错都要重插相机。

可选的下一步：

1. **Frida 插桩像素蛋糕**，直接 dump `bulkTransfer` 的收发字节（需要 root，或把 APK 重打包注入 gadget）。
   这是唯一能一次性拿到完整命令序列的办法。
2. 继续黑盒试探（每轮 20 分钟构建 + 一次重插），命中概率低。
3. 接受现状：联机 + 监看（10fps）+ 远程快门；照片用读卡器 / 相机 Wi-Fi。

## 12. 更正：§10/§11 的"固件不支持"结论是错的（2026-10-28 晚）

Frida 这条路走不通 —— 像素蛋糕有反调试，一 attach 就 `SIGBUS @ 0xdead9001` 自毁
（`am_crash ... Native crash, Bus error`），空脚本 attach 也一样，说明检测的是注入本身，
不是我们的 hook。于是改去查"有没有别人已经把这台机身跑通过"。

有，而且是最硬的那种证据：libgphoto2 的机型表里就列着我们这具机身和它的 USB ID。

```
camlibs/ptp2/library.c
  {"Sony:ILCE-7M2 (Control)", 0x054c, 0x0a6a, PTP_CAP|PTP_CAP_PREVIEW}

camera_capture() 分派：
  if (VendorExtensionID == PTP_VENDOR_SONY &&
      ptp_operation_issupported(0x9207 SDIO_ControlDevice))
        return camera_sony_capture(...);
```

也就是说，A7M2 的取图**不需要** `0x923B/0x923C/0x923D` 那套读卡操作，
也不需要切 MTP；Sony 给 ILCE 系列留了更直接的一条：**拍进相机内存，再从虚拟句柄整读**。
§10、§11 里"固件层面不支持"的判断，是因为我们只盯着像素蛋糕的读卡路径，漏了这条。

### 我们漏掉的两步

1. **`0x9202` 得按 PTP 3.00（`0x012C`, 1）请求**。我们一直发 `0x00C8`（PTP 2.00），
   机身按 200 回包，返回的"扩展操作/属性/事件清单"是空的 —— 于是 `DeviceInfo` 里
   `properties=0`、`0x9209` 属性容器也解析不出条目，`0xD215 / 0xD213 / 0xD2C1 / 0xD2C2`
   全被判成"这台机身没有"。
2. **快门要半按 → 全按 → 反序松开**。只发全按（`0xD2C2`）机身不会进入"拍摄中"状态，
   也就不会把这一张放进内存缓存；之后 `0x1009 @ 0xFFFFC001` 自然只能回 `InvalidObjectHandle`。

另外，"拍完了没有"不该靠事件猜，也不该靠 `0x9209`（老机身那份容器解不出来），
而是 `0x1014 GetDevicePropDesc(0xD215)`：`>= 0x8000` 就表示内存里有一张等着取。

### 现在的实现

```
清缓存 0x1014(0xD215) ≥ 0x8000 → 先读走 0xFFFFC001 丢掉
半按   0x9207 param=0xD2C1 data=u16 2
全按   0x9207 param=0xD2C2 data=u16 2
停住   最多 1s：等 0xC201 事件或 0xD213 ∈ {2,3}
松开   0xD2C2 → 1，再 0xD2C1 → 1
等就绪 0x1014(0xD215) 轮询到 ≥ 0x8000
取图   0x1009(0xFFFFC001) 整读；按魔数区分 JPEG / RAW(ARW)
```

§10 那张"不支持"的表依然有效 —— `0x923B/0x9212/0x1007/0x101B` 在这具机身上确实一按就断链，
只是它们都不是回传的正路。真机结果见 §13。

## 13. 按 Sony 官方序列重写之后的实测

### 第一轮（v0.1.3 构建前，OPPO Find X8 Ultra + ILCE-7M2）：联机成功，取图被并发打断

`0x9202 (0x12C, 1)` 这一条立即见效 —— 机身回了 86 字节扩展清单，
`DeviceInfo` 从 `properties=0` 变成 `properties=38`：

```
Sony extended protocol version=0x00C8 bytes=86
Sony vendor codes ops=[] props=[0x5004,0x5005,...,0xD213,0xD214,0xD215,...,0xD221,0xD2C1,0xD2C2,...] events=[]
Sony DeviceInfo model=ILCE-7M2 version=4.0 operations=16 properties=38 events=3
ops=[0x1001,0x1002,0x1003,0x1004,0x1005,0x1006,0x1007,0x1008,0x1009,0x100A,0x101B,
     0x9201,0x9202,0x9205,0x9207,0x9209]
```

即 `0xD213 / 0xD215 / 0xD2C1 / 0xD2C2` 这台机身**全都支持** —— 之前判成"没有"完全是
请求参数（`0x00C8` 单参数）导致清单为空。

但按下远程快门时链路立刻死掉：

```
00:31:43.921 state=capturing
00:31:43.922 PTP send op=0x1014 tx=9 params=0x0000D215
00:31:43.924 USB bulk-IN retry=1 result=-1 requested=512 remaining=12   ← 2ms 就失败
... 之后每 5s 重试一次，五个来回 ...
00:32:05.661 PTP send op=0x1009 tx=37 params=0xFFFFC001
00:32:05.662 failure SonyPtpException: USB write to Sony camera failed.
```

相机没有掉线（`dumpsys usb` 里 `/dev/bus/usb/001/007` 一直在，`product_name=ILCE-7M2`），
只是**再也不应答**。原因是两条线程共用同一个 bulk IN 端点：

- 相机页一打开就在跑取景（`0x1009 @ 0xFFFFC002` 每个帧一次）；
- 按快门时 `stopLiveView()` 只把 future 置空就走，帧线程可能还卡在 `bulkTransfer` 里；
- 快门线程紧接着写下一条命令 → 端点当场回 `-1`，之后整条管线错位。

修法两条：

1. `SonyPtpTransport.execute()` 全部串行化（一个 `ioLock`），一个端点同一时刻只允许一条事务；
2. `stopLiveView()` 先等帧线程退出（最多 3s）再发下一条命令。

顺带修掉一个更危险的分支：`0xD215` 在相机写卡期间读不到（回 `DeviceBusy`）时，
旧代码会当成"这台机身没有 D215"，转去盲读 `0xFFFFC001` —— 那正是会把固件链路打死的那一步。
现在只要 `0x9202` 清单里有 `0xD215`，读不到就只是"还没好"，继续等，绝不盲读。

### 第二轮（v0.1.3，第一版构建）：串行化之后暴露出第二个问题

加了 `ioLock` 与"停止取景要等帧线程退出"之后，并发写坏端点的现象没再出现，
但按下快门前后出现了新的断链：

```
01:05:37.738 live-view cycle=9 jpegBytes=112328      ← 取景正常，~10fps
01:05:38.122 PTP send op=0x1014 tx=21 params=0x0000D215   ← 取景线程里发的属性读取
01:05:43.299 USB bulk-IN retry=2 result=-1 requested=512 remaining=12
01:05:48.419 USB bulk-IN retry=3 ...
01:05:58.667 failure SonyPtpException: USB write to Sony camera failed.
01:05:58.682 stream session stopped frames=10 elapsedMs=21689 avgFps=0.46
```

**取景流在跑的时候，这具机身不回答属性读取**（`0x1014`）。我们之前从来没在取景中读过属性，
所以这条一直没暴露；这一版为了让"拍完自动判断就绪"更聪明，把 `pollCapturedJpeg()` 也挂到了
取景线程上，它每帧都读一次 `0xD215`，于是每帧都在打断流。

修法：`pollCapturedJpeg()` 在 `captureInProgress` 为假时直接返回。
取景那一侧只允许 `0x1009` 一条事务；属性读取只发生在快门流程里（那时取景已经停掉）。

### 第三轮（v0.1.3，第二版构建）：取景不是原因

串行化 + 不在取景中读属性之后，按下快门仍然死在同一条命令上，而且这次连**取景都没开**
（刚联机、直接点首页的"远程快门"）：

```
02:17:03.469 state=capturing
02:17:03.507 PTP send op=0x1014 tx=9 params=0x0000D215
02:17:03.512 USB bulk-IN retry=1 result=-1
02:17:08.745 PTP send op=0x9207 ...  → USB bulk-OUT failed op=0x9207 result=-1
```

所以问题不在并发、也不在取景，而在 `0x1014` 本身。相机自己的操作表就是答案：

```
ops=[0x1001,0x1002,0x1003,0x1004,0x1005,0x1006,0x1007,0x1008,0x1009,0x100A,0x101B,
     0x9201,0x9202,0x9205,0x9207,0x9209]
```

**这台机身没有实现标准 `GetDevicePropDesc(0x1014)`。** 发过去之后固件不再应答，
连 bulk-OUT 都开始返回 `-1`（相机没掉线，`dumpsys usb` 里还在，只是不再说话），
只能靠重插恢复。Sony 自己的属性描述码是 `0x9203`，同样不在支持表里。

唯一可用的属性通道是 `0x9209 SDIO_GetAllExtDevicePropInfo`：一次返回整份属性数组
（这台机身上 1118 字节），按 Sony 的 DPD 记录格式解出一条条属性 —— 也就是
libgphoto2 里 `ptp_unpack_Sony_DPD` 干的事。

### 第四轮（v0.1.3，第三版构建）：改为 0x9209 + 扫描兜底

改动：

- `readPropertyValue()` 只走 `0x9209`，不再发 `0x1014`；
- 顺序解析（计数 + 记录）为主，解析器走不下去时退到"按记录头扫字节"：
  用 16 位属性码 + 已知宽度的 DataType + 合法取值范围三重校验，避免命中枚举列表里的巧合；
- 联机/取景/取图共用一份属性数组，诊断时把整包 1118 字节按 120 字符分段打一次；
- 快门失败若判定为"USB 链路已死"，自动 `CloseSession → OpenSession`（实测能救回来）
  后重试一次，不再直接把用户丢在"请拔插线"。

真机结果见下一节。



