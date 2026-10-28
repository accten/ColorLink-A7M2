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

    /**
     * SDIO_GetExtDeviceInfo(0x9202) 第一个参数：向机身申请 PTP 3.00 扩展协议。
     *
     * 之前这里传的是 0x00C8(200)，机身按 200 回包，返回的"扩展操作/属性/事件清单"是空的，
     * 于是 DeviceInfo 里 properties=0、0x9209 属性容器也解析不出来 —— 老机身（ILCE-7M2）
     * 的 D215/D2C1/D2C2 全都读不到。改成和 libgphoto2 一致的 0x012C(300) 才会交清单。
     */
    private const val SONY_PROTOCOL_EXTENDED = 0x012C
    private const val MAX_CONTAINER_BYTES = 100 * 1024 * 1024
    private const val MAX_USB_READ_BYTES = 64 * 1024
    private const val USB_TIMEOUT_MS = 5_000


    /** 没有 D215 的机身：等相机把这一张写完再读虚拟回传句柄（24MP JPEG 约 2~3s） */
    private const val CAPTURE_SETTLE_BEFORE_READ_MS = 2_800L

    /** 两次试读之间的间隔：太密会把 A7M2 的 PTP 打僵 */
    private const val CAPTURE_PROBE_INTERVAL_MS = 1_200L

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

  /** 0x1014 连续读不到 D215 的次数：够多就不再用它，避免每次轮询空跑一条命令 */
  private var propDescMisses = 0

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
  }

  /** Reads and parses every device property the camera currently reports. */
  private fun readDeviceProperties(): List<SonyDeviceProperty> {
    val result = execute(0x9209, expectsData = true, allowBusy = true)
    val raw = result.data
    val properties = raw?.let(SonyPtpProperties::parseAll).orEmpty()
    // 只打一次原始字节：早期机身的属性容器格式和老机身解析器对不上时，
    // 光看"parsed=0"没法定位，得看到真实字节（ILCE-7M2 就是这种情况）。
    if (!tracedPropertyCodes && raw != null) {
      tracedPropertyCodes = true
      val sonyCodes = properties.map { it.code }.filter { it and 0xFF00 == 0xD200 }
      trace(
        "Sony prop blob bytes=${raw.size} parsed=${properties.size} " +
          "head=${raw.take(48).joinToString("") { "%02X".format(it) }}",
      )
      trace("Sony device properties=${properties.size} sony=${sonyCodes.joinToString(",") { it.hex() }}")
    }
    return properties
  }

  /**
   * 读单个属性的当前值：标准 `GetDevicePropDesc(0x1014)`。
   *
   * 老机身（ILCE-7M2）的 `0x9209` 属性大容器解析不出任何条目，但 `0x1014` 逐条问是有回的 ——
   * 上一版就是只走 0x9209，结果 D215/D213 都被判成"这台机身没有"，取图逻辑只能瞎猜。
   */
  fun readPropDescCurrent(propCode: Int): Long? {
    val result = execute(
      0x1014,
      intArrayOf(propCode),
      expectsData = true,
      acceptedResponses = setOf(
        RESPONSE_OK,
        RESPONSE_INVALID_HANDLE,
        RESPONSE_DEVICE_BUSY,
        RESPONSE_ACCESS_DENIED,
      ),
    )
    if (result.responseCode != RESPONSE_OK) return null
    val data = result.data ?: return null
    if (data.size < 7) return null
    val dataType = data.u16(2)
    val size = when (dataType) {
      0x0001, 0x0002 -> 1 // INT8 / UINT8
      0x0003, 0x0004 -> 2 // INT16 / UINT16
      0x0005, 0x0006 -> 4 // INT32 / UINT32
      0x0007, 0x0008 -> 8 // INT64 / UINT64
      else -> return null
    }
    val currentOffset = 5 + size
    if (data.size < currentOffset + size) return null
    var value = 0L
    for (index in 0 until size) {
      value = value or ((data[currentOffset + index].toLong() and 0xFFL) shl (8 * index))
    }
    return value
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
   * JPEG 走 [SonyPtpCodec.parseSonyJpegData] 剥掉 Sony 的包裹头；RAW(ARW) 是 TIFF 容器，
   * 一个 `FF D8` 都没有，旧逻辑会把它当成"没取到"直接丢掉。
   */
  private fun getObjectPayload(handle: Int): ByteArray? {
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
    if (result.responseCode != RESPONSE_OK) {
      trace("getObject handle=${"%08X".format(handle)} code=${result.responseCode.hex()}")
      return null
    }
    val data = result.data ?: return null
    if (data.isEmpty()) return null
    return SonyPtpCodec.extractSonyObjectPayload(data)
  }

  fun prepareLiveView() {
    // 参考实现的取景路径：直接 GetObject(0x1009) @ 0xFFFFC002，没有 D221 门禁。
    if (getObjectDirect(HANDLE_LIVE_VIEW) != null) {
      trace("live-view ready via GetObject(0x1009) on 0xFFFFC002")
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
    captureStartedAt = SystemClock.elapsedRealtime()

    // 开拍前先把相机内存里遗留的旧照片读走：不清的话这一枪读回来的会是上一张，
    // 而且机身要等这张取走之后才会报告新对象。
    repeat(3) {
      val stale = runCatching { readPropDescCurrent(PROPERTY_OBJECT_IN_MEMORY) }.getOrNull() ?: return@repeat
      if (stale < 0x8000) return@repeat
      trace("clearing stale in-memory object D215=0x%04X".format(stale))
      runCatching { getObjectPayload(HANDLE_CAPTURED_IMAGE) }
    }

    // Sony 的控制序列（libgphoto2 在 ILCE 上实测）：半按 → 全按 → 停住等对焦 → 松开全按 → 松开半按。
    // 只发全按(0xD2C2)不够：机身不会把这一张放进内存缓存，0xFFFFC001 永远是空的，
    // 之后 0x1009 只会回 InvalidObjectHandle —— 这正是之前一直"取不到图"的原因。
    runCatching { setButton(PROPERTY_HALF_PRESS_BUTTON, 2) }
    SystemClock.sleep(120)
    runCatching { setButton(PROPERTY_CAPTURE_BUTTON, 2) }

    val focusDeadline = SystemClock.elapsedRealtime() + CAPTURE_PRESS_HOLD_MS
    while (SystemClock.elapsedRealtime() < focusDeadline) {
      if (lastEventCode == 0xC201) break
      val focus = runCatching { readPropDescCurrent(PROPERTY_FOCUS_FOUND) }.getOrNull()
      if (focus != null && focus >= 2L) {
        trace("focus found D213=0x%04X".format(focus))
        break
      }
      SystemClock.sleep(50)
    }

    runCatching { setButton(PROPERTY_CAPTURE_BUTTON, 1) }
    runCatching { setButton(PROPERTY_HALF_PRESS_BUTTON, 1) }
  }

  fun awaitCapturedJpeg(timeoutMs: Long): ByteArray {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      try {
        pollCapturedJpeg()?.let { return it }
      } catch (error: SonyPtpException) {
        if (!error.retryable) throw error
      }
      SystemClock.sleep(100)
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

    // Sony 的"这一张可以取了"信号就是 D215(ObjectInMemory)：>= 0x8000 表示相机内存里
    // 有对象，句柄固定是 0xFFFFC001。这条属性老机身也能用 0x1014 读到，所以优先走它。
    val viaPropDesc = runCatching { readPropDescCurrent(PROPERTY_OBJECT_IN_MEMORY) }.getOrNull()
    if (viaPropDesc == null) {
      propDescMisses += 1
    } else {
      propDescMisses = 0
    }
    val objectInMemory = viaPropDesc
      ?: if (propDescMisses >= 2) {
        // 0x1014 问不到这条属性就退回 0x9209 大容器，并且别每次轮询都发（会拖慢整个流程）
        SonyPtpProperties.scalar(readDeviceProperties(), PROPERTY_OBJECT_IN_MEMORY)
      } else {
        null
      }

    if (objectInMemory != null) {
      if (objectInMemory != loggedObjectInMemory) {
        loggedObjectInMemory = objectInMemory
        trace("Sony D215 ObjectInMemory=0x%04X".format(objectInMemory))
      }
      // 没到 0x8000 之前读虚拟句柄会被固件当成非法访问（真机踩到过：整条 USB 打死）
      if (objectInMemory < 0x8000) return null
      if (!captureInProgress && objectInMemory < 0x8001) return null
      trace("Sony captured-object ready D215=0x%04X".format(objectInMemory))
      val payload = getObjectPayload(HANDLE_CAPTURED_IMAGE) ?: return null
      capturedObjectConsumed = true
      captureInProgress = false
      return payload
    }

    // D215 这条路走不通，但要分清两种情况：
    //   1) 机身支持 D215（0x9202 的清单里有），只是这一秒读不到 —— 多半是相机在写卡时回
    //      DeviceBusy(0x2019)。这种时候**绝不能**改去盲读 0xFFFFC001：对象还没准备好，
    //      固件会直接把链路打死（真机：`USB write failed`，只能重插）。安静等下一轮。
    //   2) 机身根本没有 D215（早期固件）：才退回"事件 + 定时试读"的老办法。
    if (sonyVendorCodes.properties.contains(PROPERTY_OBJECT_IN_MEMORY)) return null

    // 没有 D215 的机身（早期固件）：退回事件 + 定时试读虚拟句柄。
    //   1) 绝不能调 GetObjectHandles —— 它虽然被声明支持，但会静默挂死整条 USB；
    //   2) 也不能刚按完快门就去读虚拟句柄 —— 相机还在写卡，固件会卡住不回包。
    // 取景线程也会调到这里：没有按快门就安静返回，别把"没有新照片"当成联机失败。
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
  ): PtpResult = synchronized(ioLock) {
    executeLocked(operation, params, outgoingData, expectsData, allowBusy, acceptedResponses)
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
        readContainer()
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
      if (written <= 0) throw SonyPtpException("USB write to Sony camera failed.")
      offset += written
    }
  }

  private fun readContainer(): PtpContainer {
    val header = readExact(12)
    val length = header.u32(0).toInt()
    if (length < 12 || length > MAX_CONTAINER_BYTES) throw SonyPtpException("Sony returned an invalid PTP container size.")
    val type = header.u16(4)
    val code = header.u16(6)
    val id = header.u32(8).toInt()
    val payload = if (length == 12) byteArrayOf() else readExact(length - 12)
    return PtpContainer(type, code, id, payload)
  }

  private fun readExact(size: Int): ByteArray {
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
        if (consecutiveReadFailures >= 5) {
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
private data class PtpResult(val data: ByteArray?, val responseCode: Int)

/**
 * `SDIO_GetExtDeviceInfo(0x9202)` 交回来的 Sony 扩展清单。
 *
 * 数据布局（参考实现 `ptp_sony_get_vendorpropcodes`）：
 * ```
 * UINT16   协议版本
 * AUINT16  设备属性码
 * AUINT16  控制项码
 * ```
 * 两段数组里的每个码按高 3 位分类：0x1000 操作 / 0x4000 事件 / 0x5000 属性。
 */
internal data class SonyVendorCodes(
  val operations: Set<Int> = emptySet(),
  val events: Set<Int> = emptySet(),
  val properties: Set<Int> = emptySet(),
) {
  fun describe(): String =
    "Sony vendor codes ops=[${operations.sorted().joinToString(",") { "0x%04X".format(it) }}] " +
      "props=[${properties.sorted().joinToString(",") { "0x%04X".format(it) }}] " +
      "events=[${events.sorted().joinToString(",") { "0x%04X".format(it) }}]"
}

internal fun parseSonyVendorCodes(data: ByteArray): SonyVendorCodes {
  if (data.size < 4) return SonyVendorCodes()
  var offset = 2
  fun readCodeSet(): List<Int> {
    if (offset + 4 > data.size) return emptyList()
    val count = data.u32(offset).toInt()
    offset += 4
    if (count <= 0 || offset + count * 2 > data.size) return emptyList()
    val codes = ArrayList<Int>(count)
    repeat(count) {
      codes.add(data.u16(offset))
      offset += 2
    }
    return codes
  }
  val all = readCodeSet() + readCodeSet()
  val operations = LinkedHashSet<Int>()
  val events = LinkedHashSet<Int>()
  val properties = LinkedHashSet<Int>()
  for (code in all) {
    when (code and 0x7000) {
      0x1000 -> operations.add(code)
      0x4000 -> events.add(code)
      0x5000 -> properties.add(code)
    }
  }
  return SonyVendorCodes(operations, events, properties)
}

internal object SonyPtpCodec {
  fun buildContainer(type: Int, code: Int, transactionId: Int, payload: ByteArray): ByteArray =
    ByteBuffer.allocate(12 + payload.size).order(ByteOrder.LITTLE_ENDIAN)
      .putInt(12 + payload.size)
      .putShort(type.toShort())
      .putShort(code.toShort())
      .putInt(transactionId)
      .put(payload)
      .array()

  fun parseSonyJpegData(data: ByteArray): ByteArray? {
    if (data.size < 4) return null
    val suggestedOffset = data.u32(0).toInt()
    val searchStart = if (suggestedOffset in 0 until data.size - 1) suggestedOffset else 0
    val start = (
      findJpegStart(data, searchStart) ?: if (searchStart == 0) null else findJpegStart(data, 0)
    ) ?: return null
    var end = data.size
    for (index in data.size - 2 downTo start + 2) {
      if (data[index] == 0xFF.toByte() && data[index + 1] == 0xD9.toByte()) {
        end = index + 2
        break
      }
    }
    return data.copyOfRange(start, end)
  }

  /**
   * 把 `GetObject(0x1009)` 的 data 段还原成真实文件字节，不假设格式。
   *
   * - JPEG（`FF D8`）：可能就是原样，也可能是 Sony 的 `[u32 offset][header]JPEG` 包裹；
   * - RAW（`II*\0` / `MM\0*`）：TIFF 容器，一个 `FF D8` 都没有，直接原样返回；
   * - 其他：返回原始字节，交给上层判断。
   */
  fun extractSonyObjectPayload(data: ByteArray): ByteArray? {
    if (data.isEmpty()) return null
    if (data.size >= 4 && isObjectMagic(data, 0)) return data
    parseSonyJpegData(data)?.let { return it }
    if (data.size >= 4) {
      val offset = data.u32(0).toInt()
      if (offset in 1 until data.size - 3 && isObjectMagic(data, offset)) {
        return data.copyOfRange(offset, data.size)
      }
    }
    return data
  }

  private fun isObjectMagic(data: ByteArray, at: Int): Boolean {
    if (at + 3 >= data.size) return false
    val b0 = data[at].toInt() and 0xFF
    val b1 = data[at + 1].toInt() and 0xFF
    val b2 = data[at + 2].toInt() and 0xFF
    val b3 = data[at + 3].toInt() and 0xFF
    if (b0 == 0xFF && b1 == 0xD8) return true // JPEG
    if (b0 == 0x49 && b1 == 0x49 && b2 == 0x2A && b3 == 0x00) return true // TIFF/ARW little-endian
    if (b0 == 0x4D && b1 == 0x4D && b2 == 0x00 && b3 == 0x2A) return true // TIFF/ARW big-endian
    if (b0 == 0x89 && b1 == 0x50 && b2 == 0x4E && b3 == 0x47) return true // PNG
    return false
  }

  private fun findJpegStart(data: ByteArray, searchStart: Int): Int? =
    (searchStart until data.size - 1).firstOrNull {
      data[it] == 0xFF.toByte() && data[it + 1] == 0xD8.toByte()
    }
}

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
