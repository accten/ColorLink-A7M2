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

    /** 快门控制码（SonyStillImage）：0xD2C2 */
    private const val PROPERTY_CAPTURE_BUTTON = 0xD2C2
    private const val MAX_CONTAINER_BYTES = 100 * 1024 * 1024
    private const val MAX_USB_READ_BYTES = 64 * 1024
    private const val USB_TIMEOUT_MS = 5_000


    /** 没有 D215 的机身：等相机把这一张写完再读虚拟回传句柄（24MP JPEG 约 2~3s） */
    private const val CAPTURE_SETTLE_BEFORE_READ_MS = 2_800L

    /** 两次试读之间的间隔：太密会把 A7M2 的 PTP 打僵 */
    private const val CAPTURE_PROBE_INTERVAL_MS = 1_200L

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
      for (index in 0 until target.endpointCount) {
        val endpoint = target.getEndpoint(index)
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
          "bulkOut=${output?.address?.hex()} max=${output?.maxPacketSize}",
      )
      input?.let { clearEndpointHalt(connection, it, trace) }
      output?.let { clearEndpointHalt(connection, it, trace) }
      return SonyPtpTransport(
        connection,
        target,
        input ?: throw SonyPtpException("Sony PTP bulk input endpoint is missing."),
        output ?: throw SonyPtpException("Sony PTP bulk output endpoint is missing."),
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

  /**
   * 只有刚按过快门才允许报 CAPTURE_UNSUPPORTED。
   *
   * 取景线程也会周期性调用 `pollCapturedJpeg()`；如果那里也抛这个错，控制器会把它当成
   * 联机失败、把正在跑的取景一起掐掉（真机踩到过：按完快门取景直接停）。
   */
  @Volatile private var captureInProgress = false

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
    for (attempt in 0 until 6) {
      val info = execute(0x9202, intArrayOf(0x00C8), expectsData = true, allowBusy = true)
      if (info.data?.isNotEmpty() == true) {
        versionData = info.data
        break
      }
      SystemClock.sleep(150)
    }
    val protocolData = versionData ?: throw SonyPtpException("Sony PTP authentication did not return protocol information.")
    if (protocolData.size < 2 || protocolData.u16(0) < 0x00C8) {
      throw SonyPtpException("The Sony camera reported an unsupported PTP protocol version.")
    }
    execute(0x9201, intArrayOf(3, 0, 0), expectsData = true)

    // Read the camera's own capability lists. This must not be fatal: a body that
    // refuses GetDeviceInfo can still stream and capture, it just cannot be described
    // accurately, and an empty capability set is the honest result in that case.
    deviceInfo = runCatching {
      execute(0x1001, expectsData = true, allowBusy = true).data?.let(SonyPtpDeviceInfo::parse)
    }.getOrNull()
    deviceInfo?.let {
      trace(
        "Sony DeviceInfo model=${it.model} version=${it.deviceVersion} " +
          "operations=${it.operationsSupported.size} properties=${it.devicePropertiesSupported.size} " +
          "events=${it.eventsSupported.size} " +
          "ops=[${it.operationsSupported.sorted().joinToString(",") { code -> code.hex() }}]",
      )
    } ?: trace("Sony camera did not return DeviceInfo; capabilities will be reported as unknown")
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
    captureStartedAt = SystemClock.elapsedRealtime()
    // 参考实现的快门序列：只发 SonyStillImage(0xD2C2) 这一次控制，按下(2) → 等 1s → 松开(1)。
    // 不再发 0xD2C1 半按：A7 II 上多出来的半按可能让机身停在半按态，后续读图全部失效。
    setButton(PROPERTY_CAPTURE_BUTTON, 2)
    SystemClock.sleep(1_000)
    runCatching { setButton(PROPERTY_CAPTURE_BUTTON, 1) }
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
      "The camera fired, but no JPEG reached the app. Early bodies such as ILCE-7M2 may not " +
        "export the capture over PTP: check PC Remote save settings, or import the card directly.",
    )
  }

  fun pollCapturedJpeg(): ByteArray? {
    val properties = readDeviceProperties()
    val objectInMemory = SonyPtpProperties.scalar(properties, PROPERTY_OBJECT_IN_MEMORY)

    // 有 D215 的机身按 Sony 的规矩来：没到 0x8000 之前读虚拟句柄会打崩固件
    if (objectInMemory != null && objectInMemory < 0x8000) {
      capturedObjectConsumed = false
      return null
    }
    if (capturedObjectConsumed) return null

    if (objectInMemory != null) {
      trace("Sony captured-object ready D215=${"0x%04X".format(objectInMemory)}")
      val jpeg = getObjectDirect(HANDLE_CAPTURED_IMAGE) ?: return null
      capturedObjectConsumed = true
      return jpeg
    }

    // 没有 D215 的机身（实测 ILCE-7M2，DeviceInfo 里 properties=0）：
    //   1) 绝不能调 GetObjectHandles —— 它虽然被声明支持，但会静默挂死整条 USB；
    //   2) 也不能刚按完快门就去读虚拟句柄 —— 相机还在写卡，固件会卡住不回包。
    // 所以先等相机把这张写完，再按固定间隔试读 Sony 的虚拟回传句柄。
    // 取景线程也会调到这里：没有按快门就安静返回，别把"没有新照片"当成联机失败。
    if (!captureInProgress) return null
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
    val jpeg = getObjectDirect(HANDLE_CAPTURED_IMAGE)
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


  fun close() {
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
