package expo.modules.sonycamera

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.SystemClock
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicInteger

private const val USB_RECIPIENT_ENDPOINT = 0x02

internal class SonyPtpException(message: String, val retryable: Boolean = false) : Exception(message)

internal class SonyPtpTransport private constructor(
  private val connection: UsbDeviceConnection,
  private val usbInterface: UsbInterface,
  private val bulkIn: UsbEndpoint,
  private val bulkOut: UsbEndpoint,
  /** 中断端点在（0x83）：相机用它推 PTP 事件（例如 ObjectAdded 0xC201） */
  private val interruptIn: UsbEndpoint?,
  private val trace: (String) -> Unit,
) {
  companion object {
    private const val CONTAINER_COMMAND = 1
    private const val CONTAINER_DATA = 2
    private const val CONTAINER_RESPONSE = 3
    private const val RESPONSE_OK = 0x2001
    private const val RESPONSE_DEVICE_BUSY = 0x2019
    private const val RESPONSE_INVALID_HANDLE = 0x2009
    private const val RESPONSE_ACCESS_DENIED = 0x200F
    private const val HANDLE_CAPTURED_IMAGE = -0x3FFF // 0xFFFFC001
    private const val HANDLE_LIVE_VIEW = -0x3FFE // 0xFFFFC002
    private const val PROPERTY_OBJECT_IN_MEMORY = 0xD215
    private const val PROPERTY_LIVE_VIEW_STATUS = 0xD221

    /** 合焦状态：1→2/3 表示对上焦（Sony 用它代替"可以完全按下去了"）。 */
    private const val PROPERTY_FOCUS_FOUND = 0xD213

    /** 半按快门（S1）：不发它机身不会进入"把这一张放进内存缓存"的状态。 */
    private const val PROPERTY_HALF_PRESS_BUTTON = 0xD2C1

    /** 全按快门（S2 / SonyStillImage）：0xD2C2 */
    private const val PROPERTY_CAPTURE_BUTTON = 0xD2C2

    // ---- 监视器上那排只读参数（都用 0x9209 的属性数组读） ----
    /** 快门速度：UINT32，高 16 位分子、低 16 位分母 */
    private const val PROPERTY_SHUTTER_SPEED = 0xD20D
    /** 光圈：标准 F-Number，百分之一档 */
    private const val PROPERTY_F_NUMBER = 0x5007
    /** ISO：低 24 位是数值，0xFFFFFF 表示自动 */
    private const val PROPERTY_ISO = 0xD21E
    private const val PROPERTY_ISO_ALT = 0xD226
    /** 曝光补偿：千分之一档 */
    private const val PROPERTY_EXPOSURE_COMPENSATION = 0x5010
    private const val PROPERTY_EXPOSURE_COMPENSATION_ALT = 0xD224
    private const val PROPERTY_WHITE_BALANCE = 0x5005
    /** 电量百分比 */
    private const val PROPERTY_BATTERY = 0xD218

    /** 拍摄目标（存到主机 / 存储卡 / 两边）：枚举只有 [1, 17, 16]，出厂默认 17 */
    internal const val PROPERTY_CAPTURE_TARGET = 0xD222
    internal const val CAPTURE_TARGET_DEFAULT = 17

    /** `0xD222` 的合法枚举；写别的值机身会不再往内存缓存放照片 */
    internal val CAPTURE_TARGET_VALUES = setOf(1, 17, 16)

    /**
     * SDIO_GetExtDeviceInfo(0x9202) 第一个参数：向机身申请 PTP 3.00 扩展协议。
     *
     * 之前这里传的是 0x00C8(200)，机身按 200 回包，返回的"扩展操作/属性/事件清单"是空的，
     * 于是 DeviceInfo 里 properties=0、0x9209 属性容器也解析不出来 —— 老机身（ILCE-7M2）
     * 的 D215/D2C1/D2C2 全都读不到。改成和 libgphoto2 一致的 0x012C(300) 才会交清单。
     */
    private const val SONY_PROTOCOL_EXTENDED = 0x012C
    private const val MAX_CONTAINER_BYTES = 100 * 1024 * 1024

    /**
     * 单次 bulk-IN 最多读多少字节。
     *
     * **不要往上调。** 试过 256KB：OPPO Pad 4 Pro 的 USB 主控对超过 64KB 的读请求会直接回
     * `bulkTransfer = -1`（十几毫秒就返回，是 URB 被拒，不是 5s 超时），随后连 bulk-OUT
     * 也一起失败，整条链路死掉、只能拔插相机。实测：64KB 时取景连推 193 帧稳定；
     * 256KB 时取景第一次 `0x1009` 就 5 次重试全 -1，状态栏停在 LIVE 0 FPS。
     *
     * 一次 4.7MB 的照片回传用 64KB 也就是七十来次往返（约 150ms），没必要为这点时间赌链路。
     */
    private const val MAX_USB_READ_BYTES = 64 * 1024

    /** 属性轮询连续失败几次就停用（宁可不显示参数，也不能把联机读死） */
    private const val MAX_EXPOSURE_POLL_FAILURES = 3

    /** 一条事务里 bulk-IN 连续失败几次就放弃（属性读取只用 1 次，别为它等 25 秒） */
    private const val MAX_READ_RETRIES = 5

    /** 分块读取的窗口大小：0x101B 一次要 256KB，够 24MP JPEG 分若干次读完 */
    private const val PARTIAL_READ_CHUNK = 0x40000

    /** 写 D221=1 之后等相机切换完再读帧（真机不等的话第一条 0x1009 会一直不回包） */
    private const val LIVE_VIEW_RESTART_SETTLE_MS = 600L
    private const val USB_TIMEOUT_MS = 5_000


    /** 没有 D215 的机身：等相机把这一张写完再读虚拟回传句柄（24MP JPEG 约 2~3s） */
    private const val CAPTURE_SETTLE_BEFORE_READ_MS = 2_800L

    /** 两次试读之间的间隔：太密会把 A7M2 的 PTP 打僵 */
    private const val CAPTURE_PROBE_INTERVAL_MS = 1_200L

    /** 等回传时的 D215 轮询间隔（相机在写卡，问太勤它会不回包） */
    private const val CAPTURE_POLL_INTERVAL_MS = 500L

    /** 按住快门等对焦的最长时间（参考实现是 1s） */
    private const val CAPTURE_PRESS_HOLD_MS = 1_000L

    /** 等待+试读总共试几次就认命（约 2.8s + 4×1.2s） */
    private const val MAX_CAPTURE_PROBE_ATTEMPTS = 4

    /** PTP 的 SessionAlreadyOpened：上一次会话没正常收尾时，机体就会回这个 */
    private const val RESPONSE_SESSION_ALREADY_OPEN = 0x201E

    /** SessionNotOpen：没有打开的会话时 CloseSession 会回这个 */
    private const val RESPONSE_SESSION_NOT_OPEN = 0x2003

    /** 快门按下去了、但这台机身不通过 PTP 交照片时的错误前缀（上层据此保留会话） */
    internal const val CAPTURE_UNSUPPORTED_PREFIX = "CAPTURE_UNSUPPORTED"

    fun open(manager: UsbManager, device: UsbDevice, trace: (String) -> Unit): SonyPtpTransport {
      val target = (0 until device.interfaceCount)
        .map(device::getInterface)
        .firstOrNull { it.interfaceClass == UsbConstants.USB_CLASS_STILL_IMAGE }
        ?: throw SonyPtpException("The attached Sony device does not expose a PTP interface.")
      var input: UsbEndpoint? = null
      var output: UsbEndpoint? = null
      var interrupts: UsbEndpoint? = null
      for (index in 0 until target.endpointCount) {
        val endpoint = target.getEndpoint(index)
        if (endpoint.type == UsbConstants.USB_ENDPOINT_XFER_INT && endpoint.direction == UsbConstants.USB_DIR_IN) {
          interrupts = endpoint
          continue
        }
        if (endpoint.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
        if (endpoint.direction == UsbConstants.USB_DIR_IN) input = endpoint
        if (endpoint.direction == UsbConstants.USB_DIR_OUT) output = endpoint
      }
      val connection = manager.openDevice(device)
        ?: throw SonyPtpException("Android could not open the Sony USB device.")
      if (!connection.claimInterface(target, true)) {
        connection.close()
        throw SonyPtpException("The Sony PTP interface is already in use.")
      }
      trace(
        "USB interface=${target.id} alt=${target.alternateSetting} " +
          "bulkIn=${input?.address?.hex()} max=${input?.maxPacketSize} " +
          "bulkOut=${output?.address?.hex()} max=${output?.maxPacketSize} " +
          "interruptIn=${interrupts?.address?.hex()} max=${interrupts?.maxPacketSize}",
      )
      input?.let { clearEndpointHalt(connection, it, trace) }
      output?.let { clearEndpointHalt(connection, it, trace) }
      return SonyPtpTransport(
        connection,
        target,
        input ?: throw SonyPtpException("Sony PTP bulk input endpoint is missing."),
        output ?: throw SonyPtpException("Sony PTP bulk output endpoint is missing."),
        interrupts,
        trace,
      )
    }
  }

  private val transaction = AtomicInteger(0)
  private var sessionOpen = false
  private var liveViewTransactions = 0
  private var capturedObjectConsumed = false
  private var bufferedInput = byteArrayOf()
  private var bufferedInputOffset = 0

  /** 0x9202 交回来的 Sony 扩展清单（操作 / 事件 / 属性）。 */
  private var sonyVendorCodes = SonyVendorCodes()

  /** 只为诊断打印一次：这台机身到底上报了哪些 Sony 属性 */
  private var tracedPropertyCodes = false

  /**
   * 较早的机身（实测 ILCE-7M2）整条 `D215 ObjectInMemory` 都不上报，"拍完了没有"只能
   * 靠反复试读 Sony 的虚拟回传句柄来判断。这两个字段只用于限流与"只打一次日志"。
   */
  private var loggedMissingD215 = false
  private var lastCaptureProbeAt = 0L

  /** 快门按下时刻：没有 D215 的机身要等相机写完卡再读回传句柄 */
  private var captureStartedAt = 0L
  private var loggedSettleWait = false

  /** 已经试读了几次回传句柄：够了就认命，别让用户干等 35 秒 */
  private var captureProbeAttempts = 0

  /** 上一次看到的 D215，只在变化时打日志 */
  private var loggedObjectInMemory = Long.MIN_VALUE

  /** 一次拍摄里只记一次命令失败，否则 100 次轮询会写 100 行日志 */
  private var loggedCaptureReadFailure = false

  /** 上一次拍摄始终没有合焦：机身很可能根本没开火，超时提示要按这个说 */
  @Volatile var captureFocusMissed = false
    private set

  /** 属性轮询的熔断：连续失败到上限就彻底停掉（重连后恢复） */
  private var exposurePollFailures = 0

  @Volatile private var exposurePollingDisabled = false

  /** 已经打过日志的成功属性读数 */
  private val propDescObserved = java.util.concurrent.ConcurrentHashMap.newKeySet<Int>()

  /**
   * 只有刚按过快门才允许报 CAPTURE_UNSUPPORTED。
   *
   * 取景线程也会周期性调用 `pollCapturedJpeg()`；如果那里也抛这个错，控制器会把它当成
   * 联机失败、把正在跑的取景一起掐掉（真机踩到过：按完快门取景直接停）。
   */
@Volatile private var captureInProgress = false

  /** PTP 事件回调：code + 参数。取图最关键的 ObjectAdded(0xC201) 会在参数里带对象句柄。 */
  private val eventListeners = java.util.concurrent.CopyOnWriteArrayList<(Int, IntArray) -> Unit>()

  @Volatile private var eventLoopRunning = false
  private var eventThread: Thread? = null

  /** 最近一次事件（诊断用） */
  @Volatile var lastEventCode: Int = 0
    private set
  @Volatile var lastEventParams: IntArray = intArrayOf()
    private set

  fun addEventListener(listener: (Int, IntArray) -> Unit) {
    eventListeners.add(listener)
  }

  /**
   * 起中断端点读线程。
   *
   * A7M2 的接口里有第三个端点（0x83，interrupt IN）。相机拍完会把 ObjectAdded 事件推到这里，
   * 事件参数里就是新对象的句柄 —— 有了句柄才能 0x1009 取图。
   * 之前我们只读两个 bulk 端点，事件全丢，只能去猜 0xFFFFC001。
   */
  fun startEventLoop() {
    val endpoint = interruptIn ?: run {
      trace("no interrupt endpoint on this camera; event loop skipped")
      return
    }
    if (eventLoopRunning) return
    eventLoopRunning = true
    val thread = Thread({
      trace("event loop started endpoint=${endpoint.address.hex()} max=${endpoint.maxPacketSize}")
      val buffer = ByteArray(maxOf(16, endpoint.maxPacketSize))
      while (eventLoopRunning) {
        val read = try {
          connection.bulkTransfer(endpoint, buffer, 0, buffer.size, 1_000)
        } catch (error: Throwable) {
          trace("event read failed: ${error.message ?: error::class.java.simpleName}")
          -1
        }
        if (read < 0) {
          // 没事件时 USB 读会超时，这是正常的；断开时退出
          if (!eventLoopRunning) break
          continue
        }
        if (read < 12) continue
        val length = buffer.u32(0).toInt()
        val type = buffer.u16(4)
        if (type != 4 || length < 12) continue
        val code = buffer.u16(6)
        val paramCount = minOf((length - 12) / 4, 3)
        val params = IntArray(paramCount) { index -> buffer.u32(12 + index * 4).toInt() }
        lastEventCode = code
        lastEventParams = params
        trace("PTP event code=${code.hex()} params=${params.joinToString { it.hex32() }}")
        if (code == 0xC201 && params.isNotEmpty()) {
          // 相机自己按了快门：Body 会把新对象（0xFFFFC001）通过 ObjectAdded 告诉我们。
          // 记下来，交给监听线程去取图 —— 这条路径以前只是记日志，没人接手。
          pendingExternalHandle = params[0]
        }
        for (listener in eventListeners) {
          runCatching { listener(code, params) }
        }
      }
      trace("event loop stopped")
    }, "SonyPtpEvents")
    thread.isDaemon = true
    eventThread = thread
    thread.start()
  }

  private fun stopEventLoop() {
    eventLoopRunning = false
    eventThread?.interrupt()
    eventThread = null
  }

  /**
   * 相机自己按快门时，`ObjectAdded(0xC201)` 里的对象句柄。
   *
   * 事件线程写、监听线程读：取走即清空，保证一张照片只取一次。
   */
  @Volatile private var pendingExternalHandle = 0

  /** 取走"机身自己拍的那一张"的句柄；没有就返回 null。 */
  fun takePendingExternalCapture(): Int? {
    val handle = pendingExternalHandle
    if (handle == 0) return null
    pendingExternalHandle = 0
    return handle
  }

  /** 丢弃待取的机身快门句柄（例如 App 自己的快门路径已经处理过这一张）。 */
  fun clearPendingExternalCapture() {
    pendingExternalHandle = 0
  }

  /** 按句柄取回一整个对象（机身快门用）：先 `0x1008`，再 `0x1009`，失败退分块读。 */
  fun fetchObject(handle: Int): ByteArray? = getObjectPayload(handle)

  /** 相机内存缓存里那张回传照片的句柄（`0xFFFFC001`）。 */
  val capturedImageHandle: Int get() = HANDLE_CAPTURED_IMAGE

  /** `D215 ObjectInMemory`：>= 0x8000 表示相机内存里已经有一张拍好的照片。 */
  fun objectInMemory(): Long? = readPropertyValue(PROPERTY_OBJECT_IN_MEMORY)

  /** `0x1008`：对象的格式/大小/文件名。落盘前判断是不是 JPEG 就靠它。 */
  internal fun objectInfo(handle: Int): SonyObjectInfo? = readObjectInfo(handle)

  /** Populated during [authenticate]; null when the camera refused `GetDeviceInfo`. */
  var deviceInfo: SonyDeviceInfo? = null
    private set

  fun authenticate() {
    // 上一次会话可能没正常收尾（App 被系统杀掉、装新包、命令超时），机身会认为会话还开着，
    // 之后 OpenSession 直接不回包，用户只能拔插线。这里在开新会话前先尽力关一次：
    // 没有会话时它会返回 SessionNotOpen(0x2003)，无害。
    runCatching {
      execute(
        0x1003,
        acceptedResponses = setOf(RESPONSE_OK, RESPONSE_SESSION_NOT_OPEN),
      )
      trace("sent a best-effort CloseSession before opening a new session")
    }
    val open = execute(
      0x1002,
      intArrayOf(1),
      acceptedResponses = setOf(RESPONSE_OK, RESPONSE_SESSION_ALREADY_OPEN),
    )
    if (open.responseCode == RESPONSE_SESSION_ALREADY_OPEN) {
      // 上一次会话没正常收尾（进程被杀、上一条命令超时）时机体回 SessionAlreadyOpened。
      // 先 CloseSession 再重开一次，比让用户拔插 USB 线友好得多。
      trace("OpenSession returned SessionAlreadyOpened; closing stale session and retrying once")
      runCatching { execute(0x1003) }
      execute(0x1002, intArrayOf(1))
    }
    sessionOpen = true
    // 新会话：把属性轮询的熔断复位，否则一次失败会让整场联机都不显示参数
    exposurePollFailures = 0
    exposurePollingDisabled = false
    execute(0x9201, intArrayOf(1, 0, 0), expectsData = true)
    execute(0x9201, intArrayOf(2, 0, 0), expectsData = true)
    var versionData: ByteArray? = null
    // 先按 libgphoto2 的请求值（0x12C, 1）：只有这个版本号才会交回扩展清单。
    // 万一这具机身不认，退回我们以前用的 0x00C8，保证联机本身不会失败。
    val extInfoRequests = listOf(intArrayOf(SONY_PROTOCOL_EXTENDED, 1), intArrayOf(0x00C8))
    for (request in extInfoRequests) {
      for (attempt in 0 until 3) {
        val info = execute(0x9202, request, expectsData = true, allowBusy = true)
        if (info.data?.isNotEmpty() == true) {
          versionData = info.data
          break
        }
        SystemClock.sleep(150)
      }
      if (versionData != null) break
      trace("Sony extended-info request ${request.joinToString { it.hex32() }} returned nothing; trying fallback")
    }
    val protocolData = versionData
      ?: throw SonyPtpException("Sony PTP authentication did not return protocol information.")
    val protocolVersion = protocolData.u16(0)
    trace("Sony extended protocol version=0x%04X bytes=%d".format(protocolVersion, protocolData.size))
    sonyVendorCodes = parseSonyVendorCodes(protocolData)
    trace(sonyVendorCodes.describe())
    execute(0x9201, intArrayOf(3, 0, 0), expectsData = true)

    // Read the camera's own capability lists. This must not be fatal: a body that
    // refuses GetDeviceInfo can still stream and capture, it just cannot be described
    // accurately, and an empty capability set is the honest result in that case.
    deviceInfo = runCatching {
      execute(0x1001, expectsData = true, allowBusy = true).data?.let(SonyPtpDeviceInfo::parse)
    }.getOrNull()?.let { info ->
      // Sony 把真正支持的操作/属性/事件藏在 0x9202 的清单里，DeviceInfo 里往往一个都没有。
      // 合并进去之后上层（以及 "这台机身到底有没有 D215" 这种判断）才看得到真相。
      info.copy(
        operationsSupported = info.operationsSupported + sonyVendorCodes.operations,
        devicePropertiesSupported = info.devicePropertiesSupported + sonyVendorCodes.properties,
        eventsSupported = info.eventsSupported + sonyVendorCodes.events,
      )
    }
    deviceInfo?.let {
      trace(
        "Sony DeviceInfo model=${it.model} version=${it.deviceVersion} " +
          "operations=${it.operationsSupported.size} properties=${it.devicePropertiesSupported.size} " +
          "events=${it.eventsSupported.size} " +
          "ops=[${it.operationsSupported.sorted().joinToString(",") { code -> code.hex() }}]",
      )
    } ?: trace("Sony camera did not return DeviceInfo; capabilities will be reported as unknown")
    if (sonyVendorCodes.properties.isNotEmpty()) {
      val sonyProps = sonyVendorCodes.properties.sorted().joinToString(",") { it.hex() }
      trace("Sony vendor properties=$sonyProps")
    }
  }

  fun prepareStillCapture() {
    // These documented properties select host dial control and still capture.
    runCatching { execute(0x9205, intArrayOf(0xD25A), outgoingData = byteArrayOf(1)) }
    runCatching { execute(0x9205, intArrayOf(0x5013), outgoingData = le32(1)) }
    // `0xD222 拍摄目标`（照片存到哪）不在这里写：由控制器按用户的设置调 setCaptureTarget()。
  }

  /**
   * 写 `0xD222 拍摄目标`：照片存到主机 / 存储卡 / 两边。
   *
   * 合法枚举只有 [1, 17, 16]（读属性数组得到的 form 枚举）。早期为了"拍完传到 host"
   * 试过写 2，机身收到非法值之后就不再往内存缓存放照片（`D215` 永远不涨）——
   * 所以这里对非法值直接回落到出厂默认 17，绝不把野值写进去。
   */
  fun setCaptureTarget(value: Int) {
    val safe = if (value in CAPTURE_TARGET_VALUES) value else CAPTURE_TARGET_DEFAULT
    execute(0x9205, intArrayOf(PROPERTY_CAPTURE_TARGET), outgoingData = le16(safe))
    trace("D222 capture target = 0x%04X".format(safe))
  }

  /** One `0x9209` read: the camera's whole property array, or null when it refused. */
  private fun readPropertyBlob(maxReadRetries: Int = MAX_READ_RETRIES): ByteArray? {
    val result = execute(0x9209, expectsData = true, allowBusy = true, maxReadRetries = maxReadRetries)
    val raw = result.data
    if (raw == null || raw.size < 12) return null
    return raw
  }

  /** Reads and parses every device property the camera currently reports (0x9209). */
  private fun readDeviceProperties(): List<SonyDeviceProperty> {
    val raw = readPropertyBlob() ?: return emptyList()
    val scan = SonyPtpProperties.scan(raw)
    tracedPropertyBlob(raw, scan)
    return scan.parsed
  }

  /**
   * 第一阶段诊断：整包按 120 字符分段打一次（外加解析器停在哪）。
   *
   * eventLog 会把 >=200 字符的纯字母数字串当 base64 打码，所以每段必须短于 200。
   * 解析器和这具机身的记录格式对不上时，这段 hex 是唯一能离线复盘的证据。
   */
  private fun tracedPropertyBlob(raw: ByteArray, scan: SonyPropBlobScan) {
    if (tracedPropertyCodes) return
    tracedPropertyCodes = true
    val sonyCodes = scan.parsed.map { it.code }.filter { it and 0xFF00 == 0xD200 }
    trace(
      "Sony prop blob bytes=${raw.size} declared=${scan.declared} parsed=${scan.parsed.size} " +
        "failure=${scan.failure ?: "-"} at=${scan.failureOffset} window=${scan.window}",
    )
    trace("Sony device properties=${scan.parsed.size} sony=${sonyCodes.joinToString(",") { it.hex() }}")
    val hex = raw.joinToString("") { "%02X".format(it) }
    var part = 0
    var index = 0
    while (index < hex.length) {
      trace("propblob[$part]=${hex.substring(index, minOf(index + 120, hex.length))}")
      index += 120
      part += 1
    }
  }

  /**
   * 读单个属性的当前值。
   *
   * **不能用 0x1014。** 这台机身的 DeviceInfo 操作表里根本没有标准 `GetDevicePropDesc(0x1014)`：
   *
   *   ops=[0x1001..0x100A,0x101B,0x9201,0x9202,0x9205,0x9207,0x9209]
   *
   * 真机上发 0x1014 的后果是 USB 读立刻返回 -1，随后连写命令都返回 -1 ——
   * 整个 bulk 端点报废、只能重插（三次真机复现）。Sony 自己的 `GetDevicePropDesc`
   * 是厂商码 0x9203，但那也没在支持表里。
   *
   * 唯一可用的属性通道是 `0x9209 SDIO_GetAllExtDevicePropInfo`：它一次交出整份属性数组
   * （这台机身上 1118 字节），再按 Sony 的 DPD 记录格式解出 D215/D213。
   * 顺序解析走不通时（记录宽度和文档不一致会整段错位），退到"按记录头扫字节"。
   */
  fun readPropertyValue(propCode: Int): Long? {
    val raw = readPropertyBlob() ?: return null
    val scan = SonyPtpProperties.scan(raw)
    tracedPropertyBlob(raw, scan)
    var value = SonyPtpProperties.scalar(scan.parsed, propCode)
    if (value == null) {
      value = SonyPtpProperties.findValueByScan(raw, propCode, plausibleMax(propCode))
      if (value != null) {
        trace(
          "prop 0x%04X value=0x%X via byte scan (sequential walk stopped at %d)".format(
            propCode,
            value,
            scan.failureOffset,
          ),
        )
      }
    }
    if (value != null && propDescObserved.add(propCode)) {
      trace("prop 0x%04X value=0x%X".format(propCode, value))
    }
    return value
  }

  /** 这具机身会给出的合法取值范围：用来把"扫到看起来像的地方"过滤掉。 */
  private fun plausibleMax(propCode: Int): Long = when (propCode) {
    PROPERTY_OBJECT_IN_MEMORY -> 0x8002 // 0..1 = 没货，0x8000/0x8001/0x8002 = 缓存里有 N 张
    PROPERTY_FOCUS_FOUND -> 3 // 0/1 = 未合焦，2/3 = 合焦
    PROPERTY_LIVE_VIEW_STATUS -> 1
    else -> Long.MAX_VALUE
  }

  /**
   * 监视器上那排只读参数（快门/光圈/ISO/EV/白平衡/电量）。
   *
   * 全部来自同一次 `0x9209`：这台机身的属性只走这一条通道，逐条读会把链路打死。
   * 返回值一律是"给人看的短字符串"，解不出来的项直接省略，UI 继续显示占位符。
   */
  fun readExposureSnapshot(): Map<String, Any?> {
    // 这条路径每秒都会被监看页问一次。一次读崩不能连累取景，连续几次就自己关掉 ——
    // 真机上"读属性把链路读死"不是假设，是已经踩过的坑。
    if (exposurePollingDisabled) return emptyMap()
    val raw = try {
      // 只用 2 次重试：这条路径每秒都在跑，卡住一次最多 10 秒，不能像取图那样等 25 秒。
      readPropertyBlob(maxReadRetries = 2)
    } catch (error: Throwable) {
      noteExposureFailure(error.message ?: error::class.java.simpleName)
      return emptyMap()
    }
    if (raw == null) {
      noteExposureFailure("0x9209 returned no property array")
      return emptyMap()
    }
    exposurePollFailures = 0
    val scan = SonyPtpProperties.scan(raw)
    tracedPropertyBlob(raw, scan)
    fun valueOf(vararg codes: Int): Long? {
      for (code in codes) {
        SonyPtpProperties.scalar(scan.parsed, code)?.let { return it }
        SonyPtpProperties.findValueByScan(raw, code, Long.MAX_VALUE)?.let { return it }
      }
      return null
    }

    val snapshot = linkedMapOf<String, Any?>()
    valueOf(PROPERTY_SHUTTER_SPEED)?.let { SonyExposure.shutterSpeed(it) }?.let { snapshot["shutterSpeed"] = it }
    valueOf(PROPERTY_F_NUMBER)?.let { SonyExposure.aperture(it) }?.let { snapshot["aperture"] = it }
    valueOf(PROPERTY_ISO, PROPERTY_ISO_ALT)?.let { SonyExposure.iso(it) }?.let { snapshot["iso"] = it }
    valueOf(PROPERTY_EXPOSURE_COMPENSATION, PROPERTY_EXPOSURE_COMPENSATION_ALT)
      ?.let { SonyExposure.exposureCompensation(it) }
      ?.let { snapshot["exposureCompensation"] = it }
    valueOf(PROPERTY_WHITE_BALANCE)?.let { SonyExposure.whiteBalance(it) }?.let { snapshot["whiteBalance"] = it }
    valueOf(PROPERTY_BATTERY)?.let { SonyExposure.batteryPercent(it) }?.let { snapshot["batteryPercent"] = it }
    snapshot["focusFound"] = valueOf(PROPERTY_FOCUS_FOUND)?.let { it >= 2 } ?: false
    snapshot["objectInMemory"] = valueOf(PROPERTY_OBJECT_IN_MEMORY)
    return snapshot
  }

  /** 属性轮询连续失败几次就停用：宁可不显示参数，也不能把联机读死。 */
  private fun noteExposureFailure(reason: String) {
    exposurePollFailures += 1
    if (exposurePollFailures >= MAX_EXPOSURE_POLL_FAILURES) {
      exposurePollingDisabled = true
      trace("disabling property polling after $exposurePollFailures failures: $reason")
    } else {
      trace("property poll failed ($exposurePollFailures): $reason")
    }
  }

  /**
   * 直接 `GetObject(0x1009)` 读 Sony 的虚拟句柄（取景 0xFFFFC002 / 已拍图像 0xFFFFC001）。
   *
   * 参考实现里没有 `D221` 门禁、也不先发 `GetObjectInfo(0x1008)`：
   * A7 II 这一代对虚拟句柄发 `0x1008` 会**不回包**（USB 读超时，整条管线卡死），
   * 而直接 `0x1009` 才是正常路径。所以这里只发 `0x1009`。
   */
  private fun getObjectDirect(handle: Int): ByteArray? {
    val result = execute(
      0x1009,
      intArrayOf(handle),
      expectsData = true,
      acceptedResponses = setOf(
        RESPONSE_OK,
        RESPONSE_INVALID_HANDLE,
        RESPONSE_DEVICE_BUSY,
        RESPONSE_ACCESS_DENIED,
      ),
    )
    if (result.responseCode != RESPONSE_OK) return null
    return result.data?.let(SonyPtpCodec::parseSonyJpegData)
  }

  /**
   * 取回整个对象，但不假设它是 JPEG。
   *
   * 真机实测（ILCE-7M2，D215 刚变成 0x8001 的那一瞬间）：
   * 直接 `0x1009(0xFFFFC001)` 回 `0x2001 + 0 字节`，紧接着相机就推 `0xC202 ObjectRemoved` ——
   * 也就是说"读到了、但一个字节都没给"。参考实现里有一步我们之前跳过了：
   *
   *   ptp_getobjectinfo(newobject)   ← 0x1008，先问大小/格式
   *   ptp_getobject(newobject)       ← 0x1009，整读
   *
   * 现在按这个顺序来；`0x1008` 只做一次重试（真机以前在对象不存在时它会挂住），
   * 失败也不影响后面整读。整读仍然空的话，再退到分块读（0x101B / Sony 0x923D）。
   */
  private fun getObjectPayload(handle: Int): ByteArray? {
    val info = runCatching { readObjectInfo(handle) }.getOrNull()
    if (info != null) {
      trace(
        "object info handle=${"%08X".format(handle)} format=0x%04X bytes=%d name=%s".format(
          info.format,
          info.size,
          info.name,
        ),
      )
      // RAW+JPEG 时 `0xFFFFC001` 会先交 JPEG、读走之后再交 ARW。ARW 里带一张嵌入预览，
      // BitmapFactory 也能读出尺寸，一旦落盘就是一张 24MB 的假 .jpg（真机踩到两次）。
      // 这里统一拦掉：所有取图路径（App 快门、机身快门、取景期的轮询）都走这个函数。
      if (!SonyPtpCodec.isJpegObjectFormat(info.format)) {
        trace("skip non-JPEG object format=0x%04X (%s)".format(info.format, info.name))
        return null
      }
    }

    val result = execute(
      0x1009,
      intArrayOf(handle),
      expectsData = true,
      acceptedResponses = setOf(
        RESPONSE_OK,
        RESPONSE_INVALID_HANDLE,
        RESPONSE_DEVICE_BUSY,
        RESPONSE_ACCESS_DENIED,
      ),
    )
    val data = result.data
    trace("getObject 0x1009 handle=${"%08X".format(handle)} code=${result.responseCode.hex()} bytes=${data?.size ?: 0}")
    if (result.responseCode == RESPONSE_OK && data != null && data.isNotEmpty()) {
      return SonyPtpCodec.extractSonyObjectPayload(data)
    }

    // 整读没数据：这台机身可能只认分块读。标准 0x101B 在它的操作表里。
    val partial = runCatching {
      execute(
        0x101B,
        intArrayOf(handle, 0, PARTIAL_READ_CHUNK),
        expectsData = true,
        allowBusy = true,
        acceptedResponses = setOf(RESPONSE_OK, RESPONSE_INVALID_HANDLE, RESPONSE_DEVICE_BUSY, RESPONSE_ACCESS_DENIED),
      )
    }.getOrNull()
    if (partial != null) {
      val bytes = partial.data
      trace("getObject 0x101B handle=${"%08X".format(handle)} code=${partial.responseCode.hex()} bytes=${bytes?.size ?: 0}")
      if (partial.responseCode == RESPONSE_OK && bytes != null && bytes.isNotEmpty()) {
        return SonyPtpCodec.extractSonyObjectPayload(bytes)
      }
    }
    return null
  }

  /** `0x1008 GetObjectInfo`：拿到对象大小与格式（诊断 + 让机身准备数据段）。 */
  private fun readObjectInfo(handle: Int): SonyObjectInfo? {
    val result = execute(
      0x1008,
      intArrayOf(handle),
      expectsData = true,
      maxReadRetries = 1,
      acceptedResponses = setOf(RESPONSE_OK, RESPONSE_INVALID_HANDLE, RESPONSE_DEVICE_BUSY, RESPONSE_ACCESS_DENIED),
    )
    val data = result.data ?: return null
    if (result.responseCode != RESPONSE_OK || data.size < 52) return null
    // PTPObjectInfo: storage(4) format(2) protection(2) compressedSize(4) ... filename at 52
    val format = data.u16(4)
    val size = data.u32(8).toInt()
    val name = runCatching {
      var cursor = 52
      if (cursor >= data.size) return@runCatching ""
      val characters = data[cursor].toInt() and 0xFF
      cursor += 1
      if (characters == 0) return@runCatching ""
      val end = minOf(data.size, cursor + characters * 2)
      String(data.copyOfRange(cursor, end), Charsets.UTF_16LE).trimEnd('\u0000')
    }.getOrDefault("")
    return SonyObjectInfo(size = size, format = format, name = name)
  }

  /**
   * 让相机开始/停止推取景帧：`0xD221 LiveViewStatus`（UINT8，可写，属性数组里确认过）。
   *
   * 真机上不写这一条时：相机先给一两帧，然后就再也不更新 `0xFFFFC002` 了，
   * 表现是"取景黑屏 + 读帧一直 `-1`"，而属性读取仍然正常（相机并没有睡着）。
   * 写 1 之后帧才持续产生；停止取景时写回 0，别让相机一直空推。
   */
  fun setLiveViewActive(active: Boolean) {
    val value = if (active) 1 else 0
    runCatching {
      execute(0x9205, intArrayOf(PROPERTY_LIVE_VIEW_STATUS), outgoingData = byteArrayOf(value.toByte()))
      trace("Sony live-view D221=$value requested")
    }.onFailure {
      // 老固件可能不接受写这条属性；取景能不能出帧不依赖这次写入是否成功
      trace("Sony live-view D221=$value rejected: ${it.message ?: "unknown"}")
    }
  }

  /**
   * 把相机从"省电"里叫醒：半按一下再松开。
   *
   * 真机现象：放着不动一段时间后进取景，相机只给一两帧就不再更新虚拟句柄（黑屏）；
   * 而刚按过快门的那一次，取景能稳稳跑 10fps、123 帧以上。差别就是相机醒没醒。
   * 半按是最轻的唤醒动作，不会拍照。
   */
  fun wakeCameraByHalfPress() {
    runCatching {
      setButton(PROPERTY_HALF_PRESS_BUTTON, 2)
      SystemClock.sleep(120)
      setButton(PROPERTY_HALF_PRESS_BUTTON, 1)
      trace("woke the camera with a half press")
    }.onFailure { trace("half-press wake failed: ${it.message ?: "unknown"}") }
  }

  fun prepareLiveView() {
    // 先按参考实现的最短路径试：直接 GetObject(0x1009) @ 0xFFFFC002。
    // 这台机身在相机已经"醒着推流"时一下就能成（手机实测 10fps 走的就是这条）。
    if (getObjectDirect(HANDLE_LIVE_VIEW) != null) {
      trace("live-view ready via GetObject(0x1009) on 0xFFFFC002")
      return
    }

    // 不成再请相机开始推流（D221=1）。真机上出现过"只来一两帧然后不再更新虚拟句柄"，
    // 写这条属性后才持续出帧；但它会让相机切一次内部状态，所以**不能**紧跟着读帧，
    // 否则第一条 0x1009 会一直不回包（实测 5s×3 次超时）。
    setLiveViewActive(true)
    SystemClock.sleep(LIVE_VIEW_RESTART_SETTLE_MS)
    if (getObjectDirect(HANDLE_LIVE_VIEW) != null) {
      trace("live-view ready after D221=1 restart")
      return
    }
    var lastStatus: Long? = null
    var probeRetries = 0
    repeat(50) { attempt ->
      val status = SonyPtpProperties.scalar(readDeviceProperties(), PROPERTY_LIVE_VIEW_STATUS)
      if (attempt == 0 || attempt % 10 == 0 || status != lastStatus) {
        trace("Sony live-view status D221=${status?.let { "0x%04X".format(it) } ?: "missing"}")
      }
      lastStatus = status
      if ((status ?: 0L) != 0L) {
        if (getObjectDirect(HANDLE_LIVE_VIEW) != null) return
        probeRetries += 1
        if (probeRetries >= 5) {
          throw SonyPtpException(
            "LIVE_VIEW_UNSUPPORTED: Sony reported live-view status 0x%04X but the live-view object stayed unreadable.".format(status),
          )
        }
      }
      SystemClock.sleep(100)
    }
    throw SonyPtpException(
      "LIVE_VIEW_UNSUPPORTED: this body does not expose Sony live view over PTP2 " +
        "(D221=${lastStatus?.let { "0x%04X".format(it) } ?: "missing"}).",
    )
  }

  fun getLiveViewJpeg(): ByteArray? {
    // 取景帧就是 GetObject(0x1009) @ 0xFFFFC002 返回的 Sony 包裹数据（里面是 JPEG）。
    // 不发 0x1008：A7 II 这一代对虚拟句柄的 GetObjectInfo 会不回包。
    val jpeg = getObjectDirect(HANDLE_LIVE_VIEW)
    if (liveViewTransactions <= 10) {
      trace("live-view cycle=$liveViewTransactions jpegBytes=${jpeg?.size ?: 0}")
    }
    return jpeg
  }

  fun captureStill() {
    capturedObjectConsumed = false
    captureInProgress = true
    captureProbeAttempts = 0
    loggedSettleWait = false
    loggedObjectInMemory = Long.MIN_VALUE
    loggedCaptureReadFailure = false
    captureFocusMissed = false
    captureStartedAt = SystemClock.elapsedRealtime()

    // 停取景会打断一帧的传输，那条事务的数据/响应还压在端点里。不清理就直接发命令，
    // 读到的会是上一帧的残料 —— 真机表现就是一串 `result=-1` 然后整条链路错位。
    drainPendingInput()

    // 开拍前先把相机内存里遗留的旧照片读走：不清的话这一枪读回来的会是上一张。
    // 只试一次：读不到就是读不到（相机不在"有货"状态），绝不为此在拍之前耗掉 20 秒。
    val stale = runCatching { readPropertyValue(PROPERTY_OBJECT_IN_MEMORY) }
      .onFailure { noteCaptureReadFailure("pre-capture D215", it) }
      .getOrNull()
    if (stale != null && stale >= 0x8000) {
      // RAW+JPEG 时机身会在同一个句柄上先放 JPEG、读完再放 ARW。这时候内存里的"旧片"
      // 往往已经是 ARW 了 —— 为了清掉它去整读 24MB 纯属浪费（实测 1.2 秒），先看格式。
      val info = runCatching { readObjectInfo(HANDLE_CAPTURED_IMAGE) }.getOrNull()
      if (info != null && !SonyPtpCodec.isJpegObjectFormat(info.format)) {
        trace("skip draining stale object format=0x%04X (%s); not a JPEG".format(info.format, info.name))
      } else {
        trace("clearing stale in-memory object D215=0x%04X".format(stale))
        runCatching { getObjectPayload(HANDLE_CAPTURED_IMAGE) }
      }
    }

    // Sony 的控制序列（libgphoto2 在 ILCE 上实测）：半按 → 全按 → 停住等对焦 → 松开全按 → 松开半按。
    // 只发全按(0xD2C2)不够：机身不会把这一张放进内存缓存，0xFFFFC001 永远是空的，
    // 之后 0x1009 只会回 InvalidObjectHandle —— 这正是之前一直"取不到图"的原因。
    runCatching { setButton(PROPERTY_HALF_PRESS_BUTTON, 2) }
      .onFailure { noteCaptureReadFailure("half-press", it) }
    SystemClock.sleep(120)
    runCatching { setButton(PROPERTY_CAPTURE_BUTTON, 2) }
      .onFailure { noteCaptureReadFailure("full-press", it) }

    val focusDeadline = SystemClock.elapsedRealtime() + CAPTURE_PRESS_HOLD_MS
    var focusAchieved = false
    while (SystemClock.elapsedRealtime() < focusDeadline) {
      if (lastEventCode == 0xC201) {
        focusAchieved = true
        break
      }
      val focus = runCatching { readPropertyValue(PROPERTY_FOCUS_FOUND) }
        .onFailure { noteCaptureReadFailure("D213", it) }
        .getOrNull()
      if (focus != null && focus >= 2L) {
        trace("focus found D213=0x%04X".format(focus))
        focusAchieved = true
        break
      }
      // 0x9209 是整份属性数组（1KB+），别按 50ms 的节奏灌给相机
      SystemClock.sleep(150)
    }
    if (!focusAchieved) {
      // 真机上这不是"没拍到"，而是**根本没开火**：A7M2 在 AF-S 下合不了焦就不放快门，
      // 之后 D215 一直是 0。记下来，超时时给出准确的提示，而不是笼统的"没有回传"。
      captureFocusMissed = true
      trace("no focus lock within ${CAPTURE_PRESS_HOLD_MS}ms; the body probably will not fire")
    }

    runCatching { setButton(PROPERTY_CAPTURE_BUTTON, 1) }
      .onFailure { noteCaptureReadFailure("release full", it) }
    runCatching { setButton(PROPERTY_HALF_PRESS_BUTTON, 1) }
      .onFailure { noteCaptureReadFailure("release half", it) }
  }

  /**
   * 把端点里遗留的字节读空。
   *
   * 取景被停掉时，最后一帧的事务可能只读了一半：剩下的数据还挂在 bulk-IN 上。
   * 这时发下一条命令，读到的就是上一帧的残料（或者干脆 `-1`）。
   * 只在"没有事务在飞"的时刻调用（开拍前），并且有界，最多丢 64 个包。
   */
  private fun drainPendingInput() = synchronized(ioLock) {
    bufferedInput = byteArrayOf()
    bufferedInputOffset = 0
    val scratch = ByteArray(maxOf(4096, bulkIn.maxPacketSize))
    var drained = 0
    repeat(64) {
      val read = runCatching { connection.bulkTransfer(bulkIn, scratch, 0, scratch.size, 30) }.getOrDefault(-1)
      if (read <= 0) return@synchronized
      drained += read
    }
    clearEndpointHalt(connection, bulkIn, trace)
    trace("drained $drained stale bytes from bulk-IN before capture")
  }

  private fun noteCaptureReadFailure(what: String, error: Throwable) {
    if (loggedCaptureReadFailure) return
    loggedCaptureReadFailure = true
    trace("capture step '$what' failed: ${error.message ?: error::class.java.simpleName}")
  }

  fun awaitCapturedJpeg(timeoutMs: Long): ByteArray {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      try {
        pollCapturedJpeg()?.let { return it }
      } catch (error: SonyPtpException) {
        if (!error.retryable) throw error
      }
      // 别打得太密：相机在写卡，一条命令接一条会把它逼到不回包。
      SystemClock.sleep(CAPTURE_POLL_INTERVAL_MS)
    }
    if (captureFocusMissed) {
      throw SonyPtpException(
        "CAPTURE_NO_FOCUS the camera never reported focus, so it did not fire. Switch the " +
          "camera to manual focus or point it at a subject with contrast and try again.",
      )
    }
    throw SonyPtpException(
      "The shutter fired, but no image came back over PTP. The camera (ILCE-7M2) only hands " +
        "the shot to the phone when it is captured into its in-memory buffer: check that the " +
        "camera is not in a mode that writes only to the card (e.g. RAW-only or a locked card).",
    )
  }

  /**
   * 拍完当下把几条取图路径都试一遍，并把每条的结果打进日志。
   *
   * 真机上 0xFFFFC001 只在这个窗口里有效（随后相机就发 ObjectRemoved），
   * 所以必须一次抓完；分开手动点探针时对象早就没了。
   */
  private fun tryFetchCaptured(handle: Int): ByteArray? {
    // 1) 整读 0x1009
    val whole = getObjectDirect(handle)
    trace("fetch 0x1009 handle=${"%08X".format(handle)} jpeg=${whole?.size ?: 0}")
    if (whole != null) return whole

    // 2) 标准分块 0x101B [handle, offset, size]
    runCatching {
      val partial = execute(
        0x101B,
        intArrayOf(handle, 0, 0x40000),
        expectsData = true,
        allowBusy = true,
        acceptedResponses = setOf(RESPONSE_OK, RESPONSE_INVALID_HANDLE, RESPONSE_DEVICE_BUSY, RESPONSE_ACCESS_DENIED),
      )
      trace("fetch 0x101B code=${partial.responseCode.hex()} bytes=${partial.data?.size ?: 0}")
      partial.data?.let(SonyPtpCodec::parseSonyJpegData)?.let { return it }
    }

    // 3) Sony 厂商分块 0x923D [handle, offset, totalSize, cardInfo]
    for (cardInfo in intArrayOf(0, 1)) {
      runCatching {
        val sonyPartial = execute(
          0x923D,
          intArrayOf(handle, 0, 0x40000, cardInfo),
          expectsData = true,
          allowBusy = true,
          acceptedResponses = setOf(RESPONSE_OK, RESPONSE_INVALID_HANDLE, RESPONSE_DEVICE_BUSY, RESPONSE_ACCESS_DENIED),
        )
        trace("fetch 0x923D cardInfo=$cardInfo code=${sonyPartial.responseCode.hex()} bytes=${sonyPartial.data?.size ?: 0}")
        sonyPartial.data?.let(SonyPtpCodec::parseSonyJpegData)?.let { return it }
      }
    }

    // 4) 先取 ObjectInfo 再整读
    runCatching {
      val info = execute(
        0x1008,
        intArrayOf(handle),
        expectsData = true,
        acceptedResponses = setOf(RESPONSE_OK, RESPONSE_INVALID_HANDLE, RESPONSE_DEVICE_BUSY, RESPONSE_ACCESS_DENIED),
      )
      trace("fetch 0x1008 code=${info.responseCode.hex()} bytes=${info.data?.size ?: 0}")
    }
    return null
  }
  fun pollCapturedJpeg(): ByteArray? {
    if (capturedObjectConsumed) return null
    // 取景期间不发属性读取：那一侧只允许 0x1009 一条事务。
    // 快门流程会先把取景停掉（控制器里 stopLiveView 会等帧线程退出），这里才安全。
    if (!captureInProgress) return null

    // Sony 的"这一张可以取了"信号是 D215(ObjectInMemory)：>= 0x8000 表示相机内存里有对象，
    // 句柄固定是 0xFFFFC001。这条属性只能从 0x9209 的属性数组里读（见 readPropertyValue）。
    val objectInMemory = runCatching { readPropertyValue(PROPERTY_OBJECT_IN_MEMORY) }
      .onFailure { noteCaptureReadFailure("poll D215", it) }
      .getOrNull()

    if (objectInMemory != null) {
      if (objectInMemory != loggedObjectInMemory) {
        loggedObjectInMemory = objectInMemory
        trace("Sony D215 ObjectInMemory=0x%04X".format(objectInMemory))
      }
      // 没到 0x8000 之前读虚拟句柄会被固件当成非法访问（真机踩到过：整条 USB 打死）
      if (objectInMemory < 0x8000) return null
      trace("Sony captured-object ready D215=0x%04X".format(objectInMemory))
      val payload = getObjectPayload(HANDLE_CAPTURED_IMAGE) ?: return null
      capturedObjectConsumed = true
      captureInProgress = false
      return payload
    }
    // 到这里说明 0x9209 没能给出一条可读的 D215（相机可能正忙、或者这台机身根本没有这条属性）。
    // 只要 0x9202 的清单里有 D215，就只当成"还没好"，继续等 —— 盲读 0xFFFFC001 会把链路打死。
    if (sonyVendorCodes.properties.contains(PROPERTY_OBJECT_IN_MEMORY)) return null

    // 没有 D215 的机身（早期固件）：退回事件 + 定时试读虚拟句柄。
    //   1) 绝不能调 GetObjectHandles —— 它虽然被声明支持，但会静默挂死整条 USB；
    //   2) 也不能刚按完快门就去读虚拟句柄 —— 相机还在写卡，固件会卡住不回包。
    if (!captureInProgress) return null

    // 相机通过中断端点推过 ObjectAdded(0xC201) 的话，参数里就是新对象的真实句柄。
    // 这里一次性把几种取图方式都试一遍并记录结果 —— 真机只有"拍完当下"这个窗口，分开试抓不到。
    if (lastEventCode == 0xC201 && lastEventParams.isNotEmpty()) {
      val handle = lastEventParams[0]
      trace("capture: object-added event handle=${"%08X".format(handle)}")
      val fromEvent = tryFetchCaptured(handle)
      if (fromEvent != null) {
        capturedObjectConsumed = true
        captureInProgress = false
        lastEventCode = 0
        lastEventParams = intArrayOf()
        return fromEvent
      }
    }
    val waited = SystemClock.elapsedRealtime() - captureStartedAt
    if (waited < CAPTURE_SETTLE_BEFORE_READ_MS) {
      if (!loggedSettleWait) {
        loggedSettleWait = true
        trace("capture: waiting ${CAPTURE_SETTLE_BEFORE_READ_MS}ms before reading the capture handle")
      }
      return null
    }
    val now = SystemClock.elapsedRealtime()
    if (now - lastCaptureProbeAt < CAPTURE_PROBE_INTERVAL_MS) return null
    lastCaptureProbeAt = now
    if (!loggedMissingD215) {
      loggedMissingD215 = true
      trace("D215 missing on this body; probing the Sony capture handle")
    }
    val jpeg = getObjectPayload(HANDLE_CAPTURED_IMAGE)
    if (jpeg != null) {
      capturedObjectConsumed = true
      captureInProgress = false
      return jpeg
    }
    captureProbeAttempts += 1
    if (captureProbeAttempts >= MAX_CAPTURE_PROBE_ATTEMPTS) {
      captureInProgress = false
      // 等也等过了、试也试够了：这台机身就是不在 PTP 里交照片，说清楚，别让用户干等 35 秒。
      throw SonyPtpException(
        "$CAPTURE_UNSUPPORTED_PREFIX the shutter fired, but this body does not hand the image back " +
          "over PTP after $captureProbeAttempts attempts. The photo stays on the camera card.",
      )
    }
    return null
  }


  /**
   * 诊断用：直接发一条 Sony 厂商操作，把返回码与原始字节（最多 1KB 的 hex）交给 JS。
   *
   * 逆向时最有用的一步：0x923B/0x923C/0x923D 这些取图操作的参数与返回结构没有公开文档，
   * 有了这个入口就能在真机上逐条试，不用每次改 Kotlin 重新打包。
   *
   * 注意：机身在遇到不支持的操作时可能**不回包**（USB 读超时、管线需要重连），
   * 所以它只放在设置页手动触发，不进任何自动流程。
   */
  fun probeVendorOp(
    operation: Int,
    params: IntArray,
    readBytes: Boolean = true,
    outgoingData: ByteArray? = null,
  ): Map<String, Any?> {
    val started = SystemClock.elapsedRealtime()
    return try {
      val result = execute(
        operation,
        params,
        outgoingData = outgoingData,
        expectsData = readBytes,
        allowBusy = true,
        acceptedResponses = setOf(
          RESPONSE_OK,
          RESPONSE_INVALID_HANDLE,
          RESPONSE_DEVICE_BUSY,
          RESPONSE_ACCESS_DENIED,
          RESPONSE_SESSION_NOT_OPEN,
          RESPONSE_SESSION_ALREADY_OPEN,
        ),
      )
      val data = result.data
      linkedMapOf<String, Any?>(
        "ok" to true,
        "op" to operation,
        "code" to result.responseCode,
        "bytes" to (data?.size ?: 0),
        "head" to (data?.take(1200)?.joinToString("") { "%02X".format(it) } ?: ""),
        "ms" to (SystemClock.elapsedRealtime() - started),
      )
    } catch (error: Throwable) {
      linkedMapOf<String, Any?>(
        "ok" to false,
        "op" to operation,
        "error" to (error.message ?: error::class.java.simpleName),
        "ms" to (SystemClock.elapsedRealtime() - started),
      )
    }
  }
  fun close() {
    stopEventLoop()
    if (sessionOpen) runCatching { execute(0x1003) }
    sessionOpen = false
    runCatching { connection.releaseInterface(usbInterface) }
    connection.close()
  }

  /**
   * Sony 的 `SetDeviceControlB(0x9207)`：参数是被控项（如 0xD2C2 快门），数据是 2 字节值。
   * 参考实现里：按下 = 2，松开 = 1。
   */
  private fun setButton(code: Int, value: Int) {
    execute(0x9207, intArrayOf(code), outgoingData = le16(value))
  }

  private fun execute(
    operation: Int,
    params: IntArray = intArrayOf(),
    outgoingData: ByteArray? = null,
    expectsData: Boolean = false,
    allowBusy: Boolean = false,
    acceptedResponses: Set<Int> = setOf(RESPONSE_OK),
    maxReadRetries: Int = MAX_READ_RETRIES,
  ): PtpResult = synchronized(ioLock) {
    executeLocked(operation, params, outgoingData, expectsData, allowBusy, acceptedResponses, maxReadRetries)
  }

  /**
   * PTP 事务必须串行：一个 bulk 端点只允许一条事务在飞。
   *
   * 取景线程和"按快门/读属性"是两条线程，之前没有互斥 —— 取景那一帧还在读，
   * 快门线程已经把新命令写下去了，端点立刻回 `-1`，之后整条管线再也收不到响应
   * （真机复现：取景中按快门 → `USB bulk-IN retry=1 result=-1` → `USB write failed`，
   * 相机没掉线、只是不再应答，得重插）。
   */
  private val ioLock = Any()

  private fun executeLocked(
    operation: Int,
    params: IntArray,
    outgoingData: ByteArray?,
    expectsData: Boolean,
    allowBusy: Boolean,
    acceptedResponses: Set<Int>,
    maxReadRetries: Int,
  ): PtpResult {
    // PIMA 15740 and Sony's reference require OpenSession to use transaction 0.
    // The first transaction inside the open session then starts at 1.
    val id = if (operation == 0x1002) 0 else transaction.incrementAndGet()
    val isLiveView = operation == 0x1009 && params.firstOrNull() == HANDLE_LIVE_VIEW
    if (isLiveView) liveViewTransactions += 1
    val shouldTrace = !isLiveView || liveViewTransactions <= 10 || liveViewTransactions % 30 == 0
    if (shouldTrace) trace("PTP send op=${operation.hex()} tx=$id params=${params.joinToString { it.hex32() }}")
    writeContainer(CONTAINER_COMMAND, operation, id, params.toPayload())
    if (outgoingData != null) writeContainer(CONTAINER_DATA, operation, id, outgoingData)
    var data: ByteArray? = null
    while (true) {
      val container = try {
        readContainer(maxReadRetries)
      } catch (error: SonyPtpException) {
        throw SonyPtpException(
          "PTP op ${operation.hex()} tx=$id failed while reading: ${error.message}",
          retryable = error.retryable,
        )
      }
      if (container.transactionId != id) continue
      when (container.type) {
        CONTAINER_DATA -> data = container.payload
        CONTAINER_RESPONSE -> {
          val allowed = container.code in acceptedResponses || (allowBusy && container.code == RESPONSE_DEVICE_BUSY)
          if (!allowed) {
            val retryable = container.code in setOf(RESPONSE_DEVICE_BUSY, RESPONSE_ACCESS_DENIED, RESPONSE_INVALID_HANDLE)
            trace("PTP rejected op=${operation.hex()} tx=$id code=${container.code.hex()} bytes=${data?.size ?: 0}")
            throw SonyPtpException("Sony PTP ${operation.hex()} failed with ${container.code.hex()}.", retryable)
          }
          if (shouldTrace || container.code != RESPONSE_OK) {
            trace("PTP response op=${operation.hex()} tx=$id code=${container.code.hex()} bytes=${data?.size ?: 0}")
          }
          return PtpResult(if (expectsData) data else null, container.code)
        }
      }
    }
  }

  private fun writeContainer(type: Int, code: Int, transactionId: Int, payload: ByteArray) {
    val output = SonyPtpCodec.buildContainer(type, code, transactionId, payload)
    var offset = 0
    while (offset < output.size) {
      val written = connection.bulkTransfer(bulkOut, output, offset, output.size - offset, USB_TIMEOUT_MS)
      if (written <= 0) {
        // 写失败以前只抛异常、不打日志，真机上只能看到"上层吞掉了"，没法判断是哪一步挂的
        trace("USB bulk-OUT failed op=0x%04X tx=%d result=%d at=%d/%d".format(code, transactionId, written, offset, output.size))
        throw SonyPtpException("USB write to Sony camera failed.")
      }
      offset += written
    }
  }

  private fun readContainer(maxReadRetries: Int = MAX_READ_RETRIES): PtpContainer {
    val header = readExact(12, maxReadRetries)
    val length = header.u32(0).toInt()
    if (length < 12 || length > MAX_CONTAINER_BYTES) throw SonyPtpException("Sony returned an invalid PTP container size.")
    val type = header.u16(4)
    val code = header.u16(6)
    val id = header.u32(8).toInt()
    val payload = if (length == 12) byteArrayOf() else readExact(length - 12, maxReadRetries)
    return PtpContainer(type, code, id, payload)
  }

  private fun readExact(size: Int, maxReadRetries: Int = MAX_READ_RETRIES): ByteArray {
    val output = ByteArray(size)
    var offset = 0
    var consecutiveReadFailures = 0
    while (offset < size) {
      val bufferedBytes = bufferedInput.size - bufferedInputOffset
      if (bufferedBytes > 0) {
        val count = minOf(size - offset, bufferedBytes)
        bufferedInput.copyInto(output, offset, bufferedInputOffset, bufferedInputOffset + count)
        bufferedInputOffset += count
        offset += count
        if (bufferedInputOffset == bufferedInput.size) {
          bufferedInput = byteArrayOf()
          bufferedInputOffset = 0
        }
        continue
      }

      // A USB bulk read shorter than the device's packet discards the unread
      // remainder. Always read at least one complete packet and retain bytes
      // beyond the current PTP header/payload request for the next read.
      val requestSize = maxOf(
        bulkIn.maxPacketSize,
        minOf(MAX_USB_READ_BYTES, size - offset),
      )
      val chunk = ByteArray(requestSize)
      val read = connection.bulkTransfer(bulkIn, chunk, 0, chunk.size, USB_TIMEOUT_MS)
      if (read == 0) {
        // A PTP data container whose USB transfer is an exact multiple of the
        // 512-byte max packet is terminated by a valid zero-length packet.
        // Consume it and continue reading the response container; clearing the
        // endpoint here discards Sony's following response and freezes live view.
        trace("USB bulk-IN zero-length packet requested=${chunk.size} remaining=${size - offset}")
        continue
      }
      if (read < 0) {
        consecutiveReadFailures += 1
        trace(
          "USB bulk-IN retry=$consecutiveReadFailures result=$read " +
            "requested=${chunk.size} remaining=${size - offset}",
        )
        clearEndpointHalt(connection, bulkIn, trace)
        if (consecutiveReadFailures >= maxReadRetries) {
          // Once a PTP transaction has been sent, advancing to a new command
          // after an incomplete read desynchronizes Sony's USB state machine.
          throw SonyPtpException("USB read from Sony camera could not be recovered.")
        }
        SystemClock.sleep(20)
        continue
      }
      consecutiveReadFailures = 0
      bufferedInput = if (read == chunk.size) chunk else chunk.copyOf(read)
      bufferedInputOffset = 0
    }
    return output
  }
}

private fun clearEndpointHalt(
  connection: UsbDeviceConnection,
  endpoint: UsbEndpoint,
  trace: (String) -> Unit,
) {
  val result = connection.controlTransfer(
    UsbConstants.USB_DIR_OUT or UsbConstants.USB_TYPE_STANDARD or USB_RECIPIENT_ENDPOINT,
    1, // CLEAR_FEATURE
    0, // ENDPOINT_HALT
    endpoint.address,
    null,
    0,
    1_000,
  )
  trace("USB clear-halt endpoint=${endpoint.address.hex()} result=$result")
}

private data class PtpContainer(val type: Int, val code: Int, val transactionId: Int, val payload: ByteArray)

/** What `0x1008 GetObjectInfo` reports about the object waiting on a virtual handle. */
internal data class SonyObjectInfo(val size: Int, val format: Int, val name: String)
private data class PtpResult(val data: ByteArray?, val responseCode: Int)


private fun IntArray.toPayload(): ByteArray {
  val buffer = ByteBuffer.allocate(size * 4).order(ByteOrder.LITTLE_ENDIAN)
  forEach(buffer::putInt)
  return buffer.array()
}

private fun le16(value: Int): ByteArray = ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(value.toShort()).array()
private fun le32(value: Int): ByteArray = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()
private fun ByteArray.u16(offset: Int): Int = ByteBuffer.wrap(this, offset, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF
private fun ByteArray.u32(offset: Int): Long = ByteBuffer.wrap(this, offset, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xFFFFFFFFL
private fun Int.hex(): String = "0x%04X".format(this)
private fun Int.hex32(): String = "0x%08X".format(this)
