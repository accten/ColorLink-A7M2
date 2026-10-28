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