package expo.modules.sonycamera

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.util.ArrayDeque
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal class SonyCameraController(private val context: Context) {
  interface Listener {
    fun onStateChanged(payload: Map<String, Any?>)
    fun onDeviceAttached(payload: Map<String, Any?>)
    fun onPhotoCaptured(payload: Map<String, Any?>)
    fun onFrame(jpeg: ByteArray)
  }

  companion object {
    private const val TAG = "ExpoSonyCamera"
    private const val SONY_VENDOR_ID = 0x054C
    private const val PERMISSION_ACTION_SUFFIX = ".SONY_CAMERA_USB_PERMISSION"
    private const val DIAGNOSTICS_PREFERENCE = "sony_camera_diagnostics"
    private const val DIAGNOSTICS_KEY = "trace"
    private const val MAX_DIAGNOSTICS = 2_000
    private const val MAX_PAYLOAD_DIAGNOSTICS = 200
    private const val STREAM_METRIC_INTERVAL_MS = 1_000L

    /**
     * 取景读不到帧时最多重试几次就收手。
     *
     * 真机上相机在写卡/回放时会连续回 AccessDenied：以前按 10Hz 无脑重试，几分钟堆了几千条，
     * 期间相机连 ObjectAdded 都不发，机身快门拍的照片就丢了。退避到 1s 一档后 20 次约 17 秒，
     * 够覆盖"写一张 24MP 的时间"，再久就是真卡住，应该停流让用户手动重开。
     */
    private const val MAX_EMPTY_FRAME_READS = 20

    /** 机身快门兜底：每 N 次监听循环(~1s/次)查一次 D215，防止丢了 0xC201 就永远取不到 */
    private const val BODY_SHUTTER_D215_POLL_EVERY = 5

    /** 兜底取图后的冷却：别在相机还没清理干净时连取两次同一张 */
    private const val BODY_SHUTTER_FETCH_COOLDOWN_MS = 3_000L

    /** RAW 缩略图长边（和 JS 侧 480px 的缩略图保持一致） */
    private const val RAW_THUMB_EDGE = 480

    /** 死链路自动重连的冷却：一次尝试失败后别马上再来一遍 */
    private const val DEAD_LINK_RECOVERY_COOLDOWN_MS = 15_000L

    /**
     * 机身快门一次最多读几个对象。
     *
     * RAW+JPEG 时句柄上会先摆上一枪残留的 ARW（读走它句柄才前进），再给新拍的 JPEG；
     * 所以"读一次拿不到 JPEG 就放弃"会漏照片。5 次足够跨过残留，又不会在真卡住时空转太久。
     */
    private const val BODY_SHUTTER_MAX_READS = 5

    private const val SCALAR_RECONNECT_DELAY_MS = 750L
    private const val SCALAR_DISCOVERY_COOLDOWN_MS = 2_000L
    private val CONNECT_OPTION_KEYS = setOf("candidateId", "preferredProtocol", "preferredTransport")

    /** 取景不可用但会话可用时的错误前缀：上层看到它就别把 PTP 会话一起拆掉 */
    private const val LIVE_VIEW_UNSUPPORTED_PREFIX = "LIVE_VIEW_UNSUPPORTED"
  }

  private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ExpoSonyCamera").apply { isDaemon = true }
  }
  private val streamExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ExpoSonyStream").apply { isDaemon = true }
  }
  /**
   * 属性轮询单独一条线程：取景帧在 [executor] 上长时间占着，排在那条队列里会一直等不到。
   * 真正的互斥在 transport 的 ioLock 上，这里只保证"不挡住取景"。
   */
  private val propertyExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ExpoSonyProps").apply { isDaemon = true }
  }
  private val listeners = CopyOnWriteArraySet<Listener>()
  private val connecting = AtomicBoolean(false)
  private val scalarReconnectScheduled = AtomicBoolean(false)
  private val permissionRequestPending = AtomicBoolean(false)
  private val liveViewRequested = AtomicBoolean(false)
  private val streaming = AtomicBoolean(false)
  /** 最近一次统计到的取景帧率（每秒算一次，供界面显示） */
  @Volatile private var lastFps = 0.0

  /** 取景中顺手读到的只读参数（快门/光圈/ISO/EV/WB/电量），随每秒的状态一起推给 JS */
  @Volatile private var lastExposureSnapshot: Map<String, Any?> = emptyMap()
  private var exposureMetricTick = 0
  private var loggedStreamStatePublish = false

  @Volatile private var lastScalarDiscoveryFinishedAt = 0L
  private val permissionAction = context.packageName + PERMISSION_ACTION_SUFFIX
  private val diagnosticsPreferences = context.getSharedPreferences(DIAGNOSTICS_PREFERENCE, Context.MODE_PRIVATE)
  private val cameraNetwork = SonyCameraNetwork(context, ::trace)
  private val diagnostics = ArrayDeque<String>()
  private var transport: SonyPtpTransport? = null
  private var scalarTransport: SonyScalarWebApiTransport? = null
  private var scalarDescriptor: SonyScalarWebApiTransport.Descriptor? = null
  private var device: UsbDevice? = null
  private var state = "disconnected"
  private var message: String? = null
  private var frameFuture: Future<*>? = null
  /** 实测机身不支持 USB 取景时为 true：会话保留，只关掉取景 */
  @Volatile private var liveViewUnsupported = false
  private var frameCount = 0
  private var liveViewWidth = 0
  private var liveViewHeight = 0
  // Retained so a preview still can be produced without pushing every frame across the
  // JavaScript bridge, which at ~10 fps would dominate the bridge for no benefit.
  @Volatile private var lastFrameJpeg: ByteArray? = null

  private data class ConnectPreference(
    val protocol: String?,
    val transport: String?,
    val candidateId: String?,
  ) {
    val prefersUsb: Boolean = protocol == "sony_camera_control_ptp2" || transport == "usb"
    val prefersScalar: Boolean = protocol == "sony_scalar_webapi_v1" || transport == "scalar_http"
    val prefersPtpIp: Boolean = protocol == "sony_camera_control_ptp3" || transport == "ptp_ip"
  }

  private fun parseConnectPreference(options: Map<String, Any?>): ConnectPreference? {
    val normalizedProtocol = normalizeProtocol(options["preferredProtocol"] as? String)
    val normalizedTransport = normalizeTransport(options["preferredTransport"] as? String)
    val candidateId = options["candidateId"] as? String
    val parsedCandidate = candidateId?.let(::parseCandidate)
    val protocol = normalizedProtocol ?: parsedCandidate?.first
    val transport = normalizedTransport ?: parsedCandidate?.second
    if (protocol == null && transport == null) return null
    return ConnectPreference(protocol, transport, candidateId)
  }

  private fun parseCandidate(candidateId: String): Pair<String?, String?> {
    val parts = candidateId.split(':')
    if (parts.size < 3) return null to null
    return normalizeProtocol(parts[parts.size - 2]) to normalizeTransport(parts[parts.size - 1])
  }

  private fun normalizeProtocol(value: String?): String? = when (value) {
    "sony_camera_control_ptp2", "sony_camera_control_ptp3", "sony_scalar_webapi_v1" -> value
    else -> null
  }

  private fun normalizeTransport(value: String?): String? = when (value) {
    "usb", "ptp_ip", "scalar_http" -> value
    else -> null
  }

  private val usbReceiver = object : BroadcastReceiver() {
    override fun onReceive(receiverContext: Context, intent: Intent) {
      trace("broadcast action=${intent.action}")
      when (intent.action) {
        permissionAction -> {
          val attached = intent.usbDevice()
          val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
          permissionRequestPending.set(false)
          trace("permission result granted=$granted device=${attached?.let(::describeDevice) ?: "missing"}")
          if (granted && attached != null) {
            device = attached
            enqueueConnect(attached, settleDelayMs = 300)
          } else {
            updateState("permission_required", "USB permission is required to use the Sony camera.")
          }
        }
        UsbManager.ACTION_USB_DEVICE_DETACHED -> {
          val detached = intent.usbDevice()
          permissionRequestPending.set(false)
          trace("device detached ${detached?.let(::describeDevice) ?: "unknown"}")
          if (detached == null || detached.deviceId == device?.deviceId) disconnectBlocking(preserveLiveViewRequest = true)
        }
        UsbManager.ACTION_USB_DEVICE_ATTACHED -> handleIntent(intent)
      }
    }
  }

  init {
    diagnosticsPreferences.getString(DIAGNOSTICS_KEY, null)
      ?.lineSequence()
      ?.filter(String::isNotBlank)
      ?.toList()
      ?.takeLast(MAX_DIAGNOSTICS - 1)
      ?.forEach(diagnostics::addLast)
    trace("session started sdk=${Build.VERSION.SDK_INT} knownUsbDevices=${usbManager.deviceList.size}")
    val filter = IntentFilter().apply {
      addAction(permissionAction)
      addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
      addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION")
      context.registerReceiver(usbReceiver, filter)
    }
  }

  fun addListener(listener: Listener) {
    listeners.add(listener)
    listener.onStateChanged(statePayload())
  }

  fun removeListener(listener: Listener) { listeners.remove(listener) }

  fun handleIntent(intent: Intent) {
    if (intent.action != UsbManager.ACTION_USB_DEVICE_ATTACHED) {
      trace("activity intent ignored action=${intent.action}")
      return
    }
    val attached = intent.usbDevice()
    if (attached == null) {
      trace("attach intent missing USB device")
      updateState("error", "Android opened the app for USB, but did not provide a camera descriptor.")
      return
    }
    trace("attach intent ${describeDevice(attached)}")
    if (!isSonyPtp(attached)) {
      trace("attach rejected: not Sony still-image PTP")
      updateState(
        "error",
        "Sony USB was detected, but the camera is not exposing a still-image PTP interface. Set USB Connection to PC Remote.",
      )
      return
    }
    device = attached
    val payload = payloadFor("disconnected", "Sony camera attached. Preparing USB connection.", attached)
    listeners.forEach { it.onDeviceAttached(payload) }
    if (usbManager.hasPermission(attached)) {
      if (permissionRequestPending.get()) {
        trace("permission granted; waiting for Android permission result broadcast")
      } else {
        enqueueConnect(attached, settleDelayMs = 300)
      }
    } else {
      requestPermission(attached)
    }
  }

  fun refreshAttachedDevice(autoConnect: Boolean) {
    val attached = findSonyPtpDevice()
    trace("refresh autoConnect=$autoConnect matched=${attached?.let(::describeDevice) ?: "none"}")
    if (attached == null) {
      if (device != null) disconnectBlocking()
      device = null
      if (autoConnect && scalarTransport == null && state !in setOf("connecting", "streaming", "capturing")) {
        enqueueScalarConnect()
      }
      return
    }
    device = attached
    if (!autoConnect || transport != null || state == "connecting") return
    if (usbManager.hasPermission(attached)) {
      enqueueConnect(attached, settleDelayMs = 300)
    } else {
      updateState("permission_required", "Connect the Sony camera and allow USB access.")
    }
  }

  fun statePayload(): Map<String, Any?> = payloadFor(state, message, device)

  /**
   * [options] carries the `SonyConnectOptions` contract. A recognized protocol/transport hint
   * is honored when available. Unsupported requests fail fast.
   */
  fun connectBlocking(options: Map<String, Any?> = emptyMap()): Map<String, Any?> {
    val preference = parseConnectPreference(options)
    if (preference != null) {
      trace("connect options resolved protocol=${preference.protocol} transport=${preference.transport} candidate=${preference.candidateId ?: "none"}")
      if (preference.prefersPtpIp) {
        updateState("error", "Sony Camera Control PTP/IP (PTP3) is not implemented in this release.")
        return statePayload()
      }
      if (preference.prefersScalar) {
        enqueueScalarConnect()
        return statePayload()
      }
    }
    val attached = device ?: findSonyPtpDevice()
    if (attached == null) {
      if (preference?.prefersUsb == true) {
        updateState("disconnected", "USB transport was requested, but no compatible Sony USB camera is attached.")
        return statePayload()
      }
      enqueueScalarConnect()
      return statePayload()
    }
    device = attached
    if (!usbManager.hasPermission(attached)) {
      requestPermission(attached)
      return statePayload()
    }
    enqueueConnect(attached)
    return statePayload()
  }

  private fun enqueueConnect(attached: UsbDevice, settleDelayMs: Long = 0) {
    if ((transport != null || scalarTransport != null) && state in setOf("ready", "streaming", "capturing")) return
    if (!connecting.compareAndSet(false, true)) {
      trace("connect coalesced: handshake already in flight")
      return
    }
    updateState("connecting", "Negotiating Sony Camera Control PTP 2…")
    executor.execute {
      try {
        if (settleDelayMs > 0) SystemClock.sleep(settleDelayMs)
        connectInternal(attached)
        if (liveViewRequested.get()) beginLiveView()
      } catch (error: Throwable) {
        fail(error)
      } finally {
        connecting.set(false)
      }
    }
  }

  private fun connectInternal(attached: UsbDevice): Map<String, Any?> {
    if (transport != null && state in setOf("ready", "streaming", "capturing")) return statePayload()
    trace("opening PTP transport ${describeDevice(attached)} permission=${usbManager.hasPermission(attached)}")
    scalarTransport?.close()
    scalarTransport = null
    scalarDescriptor = null
    transport?.close()
    val next = SonyPtpTransport.open(usbManager, attached, ::trace)
    try {
      trace("PTP interface claimed; authenticating")
      next.authenticate()
      trace("Sony PTP authentication complete")
      next.prepareStillCapture()
      trace("still-capture properties requested")
      // 照片存到哪（主机 / 卡 / 两边）由用户在设置里选，默认 17（出厂值）
      runCatching { next.setCaptureTarget(captureTarget) }
        .onFailure { trace("could not apply capture target: ${it.message ?: "unknown"}") }
      // 画质（JPEG / RAW / RAW+JPEG）：机身不支持就只记一条日志，不打断联机
      val formatApplied = runCatching { next.setCaptureFormat(captureFormat) }.getOrDefault(false)
      trace("capture format=$captureFormat applied=$formatApplied")
      transport = next
      // 读中断端点：相机拍完会推 ObjectAdded(0xC201)，参数里带新对象句柄
      next.startEventLoop()
      // 机身自己按快门也要把照片收回来：事件线程只负责标记，取图放在这条监听线程里
      startBodyShutterWatcher()
      updateState("ready", "Sony camera is ready.")
      return statePayload()
    } catch (error: Throwable) {
      next.close()
      throw error
    }
  }

  private fun enqueueScalarConnect() {
    if (scalarTransport != null && state in setOf("ready", "streaming", "capturing")) return
    val sinceLastDiscovery = SystemClock.elapsedRealtime() - lastScalarDiscoveryFinishedAt
    if (lastScalarDiscoveryFinishedAt > 0L && sinceLastDiscovery < SCALAR_DISCOVERY_COOLDOWN_MS) {
      trace("Scalar discovery suppressed by cooldown remainingMs=${SCALAR_DISCOVERY_COOLDOWN_MS - sinceLastDiscovery}")
      return
    }
    if (!connecting.compareAndSet(false, true)) {
      trace("Scalar connect coalesced: discovery already in flight")
      return
    }
    updateState("discovering", "Looking for a Sony camera on this Wi-Fi network…")
    executor.execute {
      try {
        cameraNetwork.acquire()
        val next = SonyScalarWebApiTransport.discover(cameraNetwork, ::trace)
        scalarDescriptor = next.descriptor()
        updateState("authenticating", "Negotiating Sony ScalarWebAPI…")
        next.connect()
        transport?.close()
        transport = null
        scalarTransport?.close()
        scalarTransport = next
        val payload = updateState("ready", "Sony Wi-Fi camera is ready.")
        listeners.forEach { it.onDeviceAttached(payload) }
        if (liveViewRequested.get()) beginLiveView()
      } catch (error: Throwable) {
        scalarTransport?.close()
        scalarTransport = null
        scalarDescriptor = null
        cameraNetwork.release()
        trace("Scalar discovery idle reason=${error.message ?: error::class.java.simpleName}")
        updateState("disconnected", "Connect to the Sony camera Wi-Fi or attach a Sony camera by USB.")
      } finally {
        lastScalarDiscoveryFinishedAt = SystemClock.elapsedRealtime()
        connecting.set(false)
      }
    }
  }

  fun startLiveView() {
    liveViewRequested.set(true)
    trace("startLiveView state=$state ptp=${transport != null} scalar=${scalarTransport != null}")
    if (transport == null && scalarTransport == null) {
      connectBlocking()
      return
    }
    beginLiveView()
  }

  private fun beginLiveView() {
    if (!streaming.compareAndSet(false, true)) return
    updateState("streaming", "Sony live view")
    val activeFrameExecutor = if (scalarTransport != null) streamExecutor else executor
    frameFuture = activeFrameExecutor.submit {
      var liveViewPrepared = false
      // 每条取景流只做一次"唤醒 + 重启"，避免无休止地折腾相机
      var liveViewRecovered = false
      frameCount = 0
      val streamSessionId = java.lang.Long.toString(System.currentTimeMillis(), 36)
      val streamStartedAt = SystemClock.elapsedRealtime()
      var lastMetricAt = streamStartedAt
      var lastMetricFrameCount = 0
      var lastMetricBytes = 0L
      var totalBytes = 0L
      var lastFrameAt = 0L
      var largestFrameGapMs = 0L
      /** 连续"没读到帧"的次数：相机忙的时候用来退避，见下面的 else 分支 */
      var emptyFrameReads = 0
      trace("stream session=$streamSessionId started protocol=${if (scalarTransport != null) "scalar" else "ptp2"}")
      while (streaming.get()) {
        var startedAt = SystemClock.elapsedRealtime()
        // 在 try 外声明：catch 里的"唤醒相机 + 重启取景"也要用得到
        var activeTransport: SonyPtpTransport? = null
        try {
          activeTransport = transport
          val activeScalar = scalarTransport
          if (activeTransport == null && activeScalar == null) break
          if (!liveViewPrepared) {
            trace("preparing Sony live-view object handle")
            if (activeScalar != null) {
              activeScalar.startLiveView()
            } else {
              activeTransport?.prepareLiveView()
            }
            liveViewPrepared = true
            trace("live-view handle ready")
            // Do not count Sony's preparation time against the first frame's
            // pacing window; the camera needs a short quiet interval here.
            startedAt = SystemClock.elapsedRealtime()
          }
          val pollTransport = activeTransport
          if (pollTransport != null && frameCount > 0 && frameCount % 10 == 0) {
            pollTransport.pollCapturedJpeg()?.let(::persistCapturedJpeg)
          }
          val jpeg = activeScalar?.getLiveViewJpeg() ?: activeTransport?.getLiveViewJpeg()
          if (jpeg != null && jpeg.isNotEmpty()) {
            emptyFrameReads = 0
            val receivedAt = SystemClock.elapsedRealtime()
            if (lastFrameAt > 0) largestFrameGapMs = maxOf(largestFrameGapMs, receivedAt - lastFrameAt)
            lastFrameAt = receivedAt
            frameCount += 1
            totalBytes += jpeg.size
            if (frameCount == 1) {
              val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
              BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
              liveViewWidth = bounds.outWidth
              liveViewHeight = bounds.outHeight
              trace("first live-view JPEG received bytes=${jpeg.size}")
              listeners.forEach { it.onStateChanged(statePayload()) }
            }
            lastFrameJpeg = jpeg
            listeners.forEach { it.onFrame(jpeg) }
            if (receivedAt - lastMetricAt >= STREAM_METRIC_INTERVAL_MS) {
              val intervalMs = maxOf(1L, receivedAt - lastMetricAt)
              val intervalFrames = frameCount - lastMetricFrameCount
              val intervalBytes = totalBytes - lastMetricBytes
              val fps = intervalFrames * 1_000.0 / intervalMs
              val averageBytes = if (intervalFrames == 0) 0L else intervalBytes / intervalFrames
              trace("stream metrics session=$streamSessionId frames=$frameCount fps=${String.format(Locale.US, "%.2f", fps)} avgBytes=$averageBytes maxGapMs=$largestFrameGapMs")
              lastMetricAt = receivedAt
              lastMetricFrameCount = frameCount
              lastMetricBytes = totalBytes
              lastFps = fps
              // 属性也在这条线程上顺手读：取景帧占满了传输锁，另开线程去抢只会饿死
              // （真机就是 `read exposure failed: TimeoutException`）。每两秒读一次足够。
              exposureMetricTick += 1
              if (exposureMetricTick >= 2) {
                exposureMetricTick = 0
                runCatching { activeTransport?.readExposureSnapshot() }
                  .getOrNull()
                  ?.let { lastExposureSnapshot = it }
              }
              if (!loggedStreamStatePublish) {
                loggedStreamStatePublish = true
                trace("publishing stream state once a second: fps + exposure")
              }
              listeners.forEach { it.onStateChanged(statePayload()) }
            }
          } else {
            // 相机在忙（写卡、回放、或者干脆不给取景）时会回 AccessDenied，读不到帧。
            // 这时候按 10Hz 硬怼是有害的：真机上连按几千次之后，相机既不回帧、也不发
            // ObjectAdded(0xC201)，机身快门拍的照片就再也回不来了。所以这里退避 + 到点收手。
            emptyFrameReads += 1
            if (emptyFrameReads == 1) trace("no live-view frame; backing off")
            if (emptyFrameReads >= MAX_EMPTY_FRAME_READS) {
              trace("no live-view frame for $emptyFrameReads reads; stopping the stream")
              streaming.set(false)
              lastFps = 0.0
              updateState("ready", "取景中断（相机一直没有回帧，可能正忙）。可以重新点开始取景。")
              break
            }
            SystemClock.sleep(emptyFrameBackoffMs(emptyFrameReads))
          }
        } catch (error: SonyPtpException) {
          if (!streaming.get()) break
          if (isLiveViewUnsupported(error)) {
            // 机身不给取景 ≠ 联机失败：快门与回传仍然可用，别把 PTP 会话一起拆掉。
            trace("live view unsupported by this body; keeping the PTP session alive")
            liveViewUnsupported = true
            streaming.set(false)
            updateState("ready", "该机型不支持 USB 实时取景（PTP2 方言差异），但可以远程快门与回传照片。")
            break
          }
          // 取景流"卡住"（相机睡着、或某一帧读超时）不等于联机失败。
          // 先尝试唤醒相机并重启推流一次：真机上"放着不动再进取景"只会来一两帧，
          // 而刚按过快门的那次能稳定 10fps——差别就是相机醒没醒。
          val recoverTransport = activeTransport
          if (!liveViewRecovered && recoverTransport != null) {
            liveViewRecovered = true
            trace("live view stalled (${error.message ?: "unknown"}); waking the camera and restarting")
            recoverTransport.wakeCameraByHalfPress()
            recoverTransport.setLiveViewActive(false)
            SystemClock.sleep(200)
            recoverTransport.setLiveViewActive(true)
            SystemClock.sleep(600)
            liveViewPrepared = false
            continue
          }
          trace("live view stalled: ${error.message ?: "unknown"}; keeping the session, stopping the stream")
          streaming.set(false)
          lastFps = 0.0
          updateState("ready", "取景中断（相机没有回帧）。可以重新点开始取景，快门与回传仍然可用。")
          break
        } catch (error: Throwable) {
          if (!streaming.get()) break
          trace("live view failed: ${error.message ?: error::class.java.simpleName}")
          streaming.set(false)
          lastFps = 0.0
          updateState("ready", "取景中断。可以重新点开始取景，快门与回传仍然可用。")
          break
        }
        val remaining = 100L - (SystemClock.elapsedRealtime() - startedAt)
        if (remaining > 0) SystemClock.sleep(remaining)
      }
      scalarTransport?.stopLiveView()
      // 会话还在就把取景关掉（D221=0），别让相机一直空推帧
      transport?.let { runCatching { it.setLiveViewActive(false) } }
      val elapsedMs = maxOf(1L, SystemClock.elapsedRealtime() - streamStartedAt)
      lastFps = 0.0
      trace("stream session=$streamSessionId stopped frames=$frameCount elapsedMs=$elapsedMs avgFps=${String.format(Locale.US, "%.2f", frameCount * 1_000.0 / elapsedMs)} maxGapMs=$largestFrameGapMs")
      if (state == "streaming") updateState("ready", "Sony camera is ready.")
    }
  }

  fun stopLiveView() {
    stopLiveView(preserveRequest = false)
  }

  private fun stopLiveView(preserveRequest: Boolean) {
    if (!preserveRequest) liveViewRequested.set(false)
    streaming.set(false)
    scalarTransport?.stopLiveView()    // 不能只把 future 置空就走人：帧线程可能正卡在 bulkTransfer 里读那一帧。
    // 那种时候立刻发下一条 PTP 命令会把端点打乱（真机：取景中按快门 →
    // `USB bulk-IN retry=1 result=-1`，紧接着 `USB write failed`；相机没掉线但不再应答，只能重插）。
    val pending = frameFuture
    frameFuture = null
    if (pending != null && !pending.isDone) {
      runCatching { pending.get(3, TimeUnit.SECONDS) }
      if (!pending.isDone) pending.cancel(false)
    }
    if (state == "streaming") updateState("ready", "Sony camera is ready.")
  }

  /**
   * Persists the most recent live-view frame and returns it as a photo payload.
   *
   * This is a preview-resolution still (typically 640x360), not a full capture. It exists
   * so an app can grab what is on screen without triggering the shutter; it is not a
   * substitute for [capturePhotoBlocking].
   */
  fun capturePreviewFrameBlocking(): Map<String, Any?> {
    val jpeg = lastFrameJpeg
      ?: throw SonyPtpException("No Sony live-view frame has been received yet.")
    return persistCapturedJpeg(jpeg, notify = false)
  }

  fun capturePhotoBlocking(): Map<String, Any?> {
    val resumeStream = liveViewRequested.get() || streaming.get()
    stopLiveView(preserveRequest = true)
    var recovered = false
    while (true) {
      try {
        val result = executor.submit<Map<String, Any?>> { runCaptureStep() }.get(45, TimeUnit.SECONDS)
        if (resumeStream) startLiveView()
        return result
      } catch (error: Throwable) {
        val cause = error.cause ?: error
        // USB 管线被打死时（真机：相机不再应答，所有 bulk-OUT 都回 -1），
        // 以前只能让用户拔插线。CloseSession + 重开一次在我们的实测里能救回来，
        // 所以这里自动试一次；救不回来再报错。
        if (!recovered && cause is SonyPtpException && isLostUsbLink(cause)) {
          recovered = true
          trace("capture lost the USB link: ${cause.message}; reconnecting once and retrying")
          runCatching {
            disconnectBlocking(preserveLiveViewRequest = true)
            connectBlocking()
          }.onFailure { reconnectError ->
            trace("reconnect after lost link failed: ${reconnectError.message ?: reconnectError::class.java.simpleName}")
          }
          continue
        }
        return handleCaptureFailure(cause, resumeStream)
      }
    }
  }

  /**
   * 监视器上那排只读参数。
   *
   * 取景中直接返回帧线程顺手读到的快照：那时传输锁被取景帧占满，另开线程去抢只会超时。
   * 非取景时走独立线程读一次，最多等 6 秒；失败就返回空表，UI 继续显示占位符 ——
   * 这条路径绝不能把取景或快门带崩。
   */
  fun readExposureBlocking(): Map<String, Any?> {
    val active = transport ?: return emptyMap()
    if (streaming.get()) return lastExposureSnapshot
    // 属性轮询已经连续失败到停用、而且是"写不出去/读不回来"那种失败：说明链路死了，
    // 自动重开一次 USB 句柄（真机上照相机 ACK 了不该写的属性之后就是这种状态）。
    if (active.linkLooksDead()) {
      recoverDeadLinkOnce()
      return emptyMap()
    }
    return try {
      propertyExecutor.submit<Map<String, Any?>> { active.readExposureSnapshot().also { lastExposureSnapshot = it } }
        .get(6, TimeUnit.SECONDS)
    } catch (error: Throwable) {
      val cause = error.cause ?: error
      trace("read exposure failed: ${cause.message ?: cause::class.java.simpleName}")
      emptyMap()
    }
  }

  /** 死链路自动重连：15 秒内最多一次，拍照/取景中不动它 */
  private var lastDeadLinkRecoveryAt = 0L
  private fun recoverDeadLinkOnce() {
    val now = SystemClock.elapsedRealtime()
    if (now - lastDeadLinkRecoveryAt < DEAD_LINK_RECOVERY_COOLDOWN_MS) return
    if (state == "capturing") return
    lastDeadLinkRecoveryAt = now
    trace("USB link looks dead; reconnecting automatically")
    executor.submit {
      runCatching {
        disconnectBlocking(preserveLiveViewRequest = true)
        connectBlocking()
      }.onFailure { trace("automatic reconnect failed: ${it.message ?: it::class.java.simpleName}") }
    }
  }

  /** One capture attempt: shutter, wait for the transfer, persist the file. */
  private fun runCaptureStep(): Map<String, Any?> {
    val activeTransport = transport
    val activeScalar = scalarTransport
    if (activeTransport == null && activeScalar == null) throw SonyPtpException("Sony camera is not connected.")
    updateState("capturing", "Capturing on Sony camera…")
    val jpeg = if (activeScalar != null) {
      activeScalar.capturePhoto()
    } else {
      requireNotNull(activeTransport).captureStill()
      activeTransport.awaitCapturedJpeg(35_000)
    }
    val payload = persistCapturedJpeg(jpeg)
    // RAW+JPEG 模式：同一张的 RAW 还挂在这个句柄上，一起收回来（像素蛋糕也是这样）
    activeTransport?.let { takeFollowUpRaw(it) }
    updateState("ready", "Photo transferred from Sony camera.")
    return payload
  }

  /** True when the failure is the USB transport dying rather than the camera refusing the shot. */
  private fun isLostUsbLink(error: SonyPtpException): Boolean {
    val message = error.message ?: return false
    return message.contains("USB write to Sony camera failed") ||
      message.contains("could not be recovered") ||
      message.contains("bulk-OUT")
  }

  private fun handleCaptureFailure(cause: Throwable, resumeStream: Boolean): Map<String, Any?> {
    if (cause is SonyPtpException && isCaptureUnsupported(cause)) {
      // 快门确实按下去了，只是这台机身不通过 PTP 交照片：保留会话，别把相机踢下线。
      // 取景在拍之前被停下过一次，这里要接回去，否则用户得重新进一次取景页（真机踩到过）。
      trace("capture unsupported by this body; keeping the PTP session alive")
      updateState("ready", cause.message?.removePrefix(SonyPtpTransport.CAPTURE_UNSUPPORTED_PREFIX)?.trim())
      if (resumeStream) startLiveView()
      throw cause
    }
    // "等不到照片"不是联机故障：相机还在正常应答属性（只是在合焦/写卡上没成）。
    // 以前这里会 fail() 把传输关掉，相机之后常常就不再应答、只能拔插。
    if (cause is SonyPtpException) {
      val message = cause.message ?: ""
      if (message.contains("CAPTURE_NO_FOCUS") || message.contains("no image came back")) {
        trace("capture produced no image; keeping the session")
        updateState("ready", "这次没拍到照片（相机没合焦或没开火）。相机仍在线，可以直接再按一次。")
        if (resumeStream) startLiveView()
        throw cause
      }
    }
    if (cause is SonyPtpException && cause.retryable && scalarTransport != null) {
      trace("recoverable Scalar capture failure preserved session: ${cause.message ?: "unknown"}")
      updateState("ready", "Sony rejected this capture. The camera remains connected; reframe and try again.")
      if (resumeStream) startLiveView()
    } else {
      fail(cause)
    }
    throw cause
  }

  /**
   * 诊断入口：把一条 Sony 厂商操作透传给当前 PTP 会话。
   * 只用于逆向摸索（取图/属性容器格式），不参与正常业务路径。
   */
  fun probeVendorOpBlocking(operation: Int, params: IntArray, outgoingData: ByteArray? = null): Map<String, Any?> {
    val active = transport
      ?: return mapOf("ok" to false, "error" to "Sony PTP session is not open (USB only)")
    val result = active.probeVendorOp(operation, params, outgoingData = outgoingData)
    val opText = "0x%04X".format(operation)
    val paramsText = params.joinToString(",") { "0x%08X".format(it) }
    trace("probe op=$opText params=$paramsText result=$result")
    return result
  }
  fun focusAtBlocking(x: Double, y: Double, viewWidth: Double, viewHeight: Double): Map<String, Any?> {
    val activeScalar = scalarTransport
      ?: return mapOf("status" to "unsupported", "reason" to "camera_unavailable")
    if (!activeScalar.supportsTouchFocus()) {
      trace("touch focus unsupported by active Scalar API list")
      return mapOf("status" to "unsupported", "reason" to "unsupported")
    }
    if (viewWidth <= 0.0 || viewHeight <= 0.0 || liveViewWidth <= 0 || liveViewHeight <= 0) {
      return mapOf("status" to "unsupported", "reason" to "preview_not_ready")
    }
    val scale = maxOf(viewWidth / liveViewWidth, viewHeight / liveViewHeight)
    val renderedWidth = liveViewWidth * scale
    val renderedHeight = liveViewHeight * scale
    val cropX = (renderedWidth - viewWidth) / 2.0
    val cropY = (renderedHeight - viewHeight) / 2.0
    val normalizedX = ((x + cropX) / renderedWidth).coerceIn(0.0, 1.0)
    val normalizedY = ((y + cropY) / renderedHeight).coerceIn(0.0, 1.0)
    return try {
      val status = executor.submit<String> { activeScalar.focusAt(normalizedX, normalizedY) }.get(10, TimeUnit.SECONDS)
      mapOf("status" to status)
    } catch (error: Throwable) {
      trace("touch focus failed: ${(error.cause ?: error).message ?: "unknown"}")
      mapOf("status" to "failed", "reason" to "focus_failed")
    }
  }

  fun disconnectBlocking(preserveLiveViewRequest: Boolean = false): Map<String, Any?> {
    stopBodyShutterWatcher()
    stopLiveView(preserveRequest = preserveLiveViewRequest)
    lastFrameJpeg = null
    val old = transport
    transport = null
    val oldScalar = scalarTransport
    scalarTransport = null
    scalarDescriptor = null
    runCatching { old?.close() }
    runCatching { oldScalar?.close() }
    if (oldScalar != null) cameraNetwork.release()
    device = findSonyPtpDevice()
    return updateState("disconnected", "Sony camera disconnected.")
  }

  // ---- 机身快门监听：相机上按快门也要把照片收回来 ----

  @Volatile private var bodyShutterWatcherRunning = false
  private var bodyShutterWatcher: Thread? = null

  /**
   * 轮询中断事件里记下的 `ObjectAdded` 句柄，把相机自己拍的那张取回来。
   *
   * 相机自己按快门 → 机身在中断端点推 `0xC201 0xFFFFC001`（前提是它把照片放进了内存缓存，
   * 也就是「PC 遥控」模式下默认会做的事）。这条线程只做一件事：看到标记就
   * `0x1008 → 0x1009` 把对象取回来，落盘并通知上层。
   *
   * 取图期间如果正在取景，会先停流再恢复：整读大对象和取景帧共用同一个 bulk 端点，
   * 抢在一起容易把相机卡住（真机踩过）。
   */
  private fun startBodyShutterWatcher() {
    if (bodyShutterWatcherRunning) return
    bodyShutterWatcherRunning = true
    bodyShutterWatcher = Thread({
      trace("body-shutter watcher started")
      var idleLoops = 0
      while (bodyShutterWatcherRunning) {
        val active = transport
        if (active == null) {
          SystemClock.sleep(300)
          continue
        }
        val handle = runCatching { active.takePendingExternalCapture() }.getOrNull()
        if (handle == null) {
          // 事件未必一定来：真机上机身按快门可能只发属性变化(0xC203)，没有 0xC201。
          // 兜底：隔一秒问一次「相机内存里有没有照片」(D215)，有就按机身快门那张取回，
          // 否则一旦事件丢了，那张照片就永远回不来（用户看到的就是"按了没反应"）。
          idleLoops += 1
          if (idleLoops >= BODY_SHUTTER_D215_POLL_EVERY) {
            idleLoops = 0
            runCatching { fetchInMemoryShotIfAny(active) }
              .onFailure { trace("body shutter fallback failed: ${it.message ?: it::class.java.simpleName}") }
          }
          SystemClock.sleep(200)
          continue
        }
        idleLoops = 0
        // App 自己按的快门有自己的路径，别两条路抢同一张
        if (state == "capturing") {
          active.clearPendingExternalCapture()
          SystemClock.sleep(200)
          continue
        }
        handleBodyShutterCapture(active, handle)
      }
      trace("body-shutter watcher stopped")
    }, "SonyBodyShutter").apply { isDaemon = true }
    bodyShutterWatcher?.start()
  }

  private fun stopBodyShutterWatcher() {
    bodyShutterWatcherRunning = false
    bodyShutterWatcher?.interrupt()
    bodyShutterWatcher = null
  }

  /** 上次兜底取图的时间：同一张不要被连取两次 */
  private var lastBodyFetchAt = 0L

  /** `0xD222`：照片存哪儿。1/16/17 为合法枚举，默认 17；联机后由 JS 侧按设置覆盖。 */
  @Volatile private var captureTarget = SonyPtpTransport.CAPTURE_TARGET_DEFAULT

  /** `0xD253`：画质。1 = RAW，2 = RAW+JPEG，3 = JPEG（默认）；联机后由 JS 侧按设置覆盖。 */
  @Volatile private var captureFormat = SonyPtpTransport.CAPTURE_FORMAT_DEFAULT

  /**
   * 设置画质（`0xD253`）。已联机时立刻写；返回 `supported` 表示机身有没有接受这次写入。
   *
   * 老机身（ILCE-7M2）的属性数组里没有 D253，写入会被拒 —— 这时上层提示去相机菜单里改，
   * 不能假装成功。
   */
  fun setCaptureFormatBlocking(value: Int): Map<String, Any?> {
    captureFormat = value
    val active = transport ?: return mapOf("supported" to true, "value" to value)
    val supported = runCatching { active.setCaptureFormat(value) }.getOrDefault(false)
    return mapOf("supported" to supported, "value" to value)
  }

  /**
   * 设置「照片保存位置」：`0xD222`。已联机时立刻生效，下次联机沿用这个值。
   *
   * 值来自相机自己的枚举 [1, 17, 16]；具体哪个是"两边都存"需要按机型实测，
   * 所以值由 JS 侧传下来，不在原生里写死。
   */
  fun setCaptureTargetBlocking(value: Int): Map<String, Any?> {
    captureTarget = value
    val active = transport
    if (active != null) {
      runCatching { active.setCaptureTarget(value) }
        .onFailure { trace("set capture target failed: ${it.message ?: "unknown"}") }
    }
    return statePayload()
  }

  /** 上一次看到的 D215：兜底只在"从没货变成有货"的边沿触发，见 fetchInMemoryShotIfAny */
  private var lastSeenD215 = 0L

  /**
   * 机身快门的兜底通道：`0xC201` 丢了也能把照片取回来。
   *
   * **必须是边沿触发**：`D215` 在照片被读走之后仍然是 `0x8001`（机身不会清），
   * 如果按"有货就去取"来做，事件通道刚取完一张，这里立刻又取一次 ——
   * 而且 RAW+JPEG 时机身第二次会交 ARW，于是图库里凭空多出一张 24MB 的 .jpg。
   * 所以只在 `D215` 从 <0x8000 跨到 >=0x8000 的那一下触发。
   */
  private fun fetchInMemoryShotIfAny(active: SonyPtpTransport) {
    if (state == "capturing") return
    val inMemory = active.objectInMemory() ?: return
    val previous = lastSeenD215
    lastSeenD215 = inMemory
    if (inMemory < 0x8000) return
    if (previous >= 0x8000) return
    val now = SystemClock.elapsedRealtime()
    if (now - lastBodyFetchAt < BODY_SHUTTER_FETCH_COOLDOWN_MS) return
    trace("body shutter fallback: D215 0x%04X -> 0x%04X without ObjectAdded; fetching".format(previous, inMemory))
    handleBodyShutterCapture(active, active.capturedImageHandle)
  }

  /** 取景读不到帧时的退避：300ms / 600ms / 1s 封顶 */
  private fun emptyFrameBackoffMs(emptyReads: Int): Long = when {
    emptyReads <= 1 -> 300L
    emptyReads <= 3 -> 600L
    else -> 1_000L
  }

  private fun handleBodyShutterCapture(active: SonyPtpTransport, handle: Int) {
    val wasStreaming = streaming.get()
    trace("body shutter: object ${"%08X".format(handle)} announced; fetching")
    lastBodyFetchAt = SystemClock.elapsedRealtime()
    if (wasStreaming) stopLiveView(preserveRequest = true)
    try {
      // RAW+JPEG 时机身把 JPEG 和 ARW 摆在同一个句柄上，而且上一枪读完 JPEG 会留一张 ARW
      // 挂在句柄上。所以不能"看到非 JPEG 就结束"——那正是"第一张正常、之后每枪都没反应"的
      // 原因：新照片的 0xC201 来了，但句柄先给的是旧 ARW，丢掉它就 return，后面的 JPEG 没取。
      // 正确做法：非 JPEG 读走（句柄才会前进），然后继续读下一个对象，直到拿到 JPEG 或次数用完。
      var jpeg: ByteArray? = null
      var sawNonJpeg = false
      var lastNonJpegFormat = 0
      for (attempt in 0 until BODY_SHUTTER_MAX_READS) {
        SystemClock.sleep(if (attempt == 0) 120L else if (attempt == 1) 300L else 600L)
        val info = runCatching { active.objectInfo(handle) }.getOrNull()
        if (info != null && !SonyPtpCodec.isJpegObjectFormat(info.format)) {
          sawNonJpeg = true
          lastNonJpegFormat = info.format
          trace(
            "body shutter: discarding non-JPEG format=0x%04X (%s), reading the next object".format(
              info.format,
              info.name,
            ),
          )
          runCatching { active.fetchObject(handle) }
          continue
        }
        val candidate = runCatching { active.fetchObject(handle) }.getOrNull() ?: continue
        // 尾部窗口放宽到 4KB：机身偶尔会在文件后面补一点东西，只有半截的才不要。
        if (SonyPtpCodec.isCompleteJpeg(candidate, tailWindow = 4096)) {
          jpeg = candidate
          break
        }
        trace("body shutter: incomplete jpeg ${candidate.size} bytes, retrying")
      }
      if (jpeg != null) {
        runCatching { persistCapturedJpeg(jpeg) }
          .onSuccess {
            takeFollowUpRaw(active)
            updateState("ready", "已取回相机上拍的那一张。")
          }
          .onFailure { updateState("ready", "照片已取回，但无法预览：${it.message ?: "unknown"}") }
      } else if (sawNonJpeg) {
        trace("body shutter: only non-JPEG objects (last format=0x%04X)".format(lastNonJpegFormat))
        updateState(
          "ready",
          if (SonyPtpCodec.isSonyRawObjectFormat(lastNonJpegFormat)) {
            "相机这一张回传的是 RAW(ARW)，已跳过；把画质改成 JPEG 就能直接调色。"
          } else {
            "相机回传的对象不是 JPEG（format=0x%04X），已跳过。".format(lastNonJpegFormat)
          },
        )
      } else {
        trace("body shutter: object ${"%08X".format(handle)} could not be fetched")
        updateState("ready", "相机拍了照片，但没能通过 USB 取回（照片在相机存储卡里）。")
      }
    } finally {
      if (wasStreaming) startLiveView()
    }
  }

  private fun persistCapturedJpeg(jpeg: ByteArray, notify: Boolean = true): Map<String, Any?> {
    val signature = jpeg.take(4).joinToString("") { "%02X".format(it) }
    // 只读尺寸，不解码像素：以前为了拿宽高，对 24MP 图做整张 decode（~100ms + 96MB 分配），
    // 白白拖慢回传。inJustDecodeBounds 只读文件头，几毫秒。
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      // Sony 的 RAW(ARW) 是 TIFF 容器，BitmapFactory 解不了。说清楚是什么，
      // 而不是丢一句"unreadable image"让用户以为传输坏了。
      if (signature == "49492A00" || signature == "4D4D002A") {
        throw SonyPtpException(
          "RAW_CAPTURE the camera returned a RAW (ARW) file, which cannot be graded yet. " +
            "Set the camera's image quality to JPEG (or RAW+JPEG) and shoot again.",
        )
      }
      throw SonyPtpException("Sony returned an unreadable image (signature=$signature, ${jpeg.size} bytes).")
    }
    val name = "sony-camera-${System.currentTimeMillis()}.jpg"
    val output = File(context.cacheDir, name)
    FileOutputStream(output).use { it.write(jpeg) }
    val payload = mapOf(
      "uri" to Uri.fromFile(output).toString(),
      "width" to bounds.outWidth,
      "height" to bounds.outHeight,
      "fileName" to name,
      "mimeType" to "image/jpeg",
      "raw" to false,
    )
    if (notify) listeners.forEach { it.onPhotoCaptured(payload) }
    trace("captured JPEG persisted bytes=${jpeg.size}")
    return payload
  }

  /**
   * 保存相机回的 RAW(ARW)。
   *
   * 和 JPEG 一样写到缓存目录，但多给一个 `thumbUri`：ARW 是 TIFF 容器，Skia 解不了，
   * 所以这里用 `BitmapFactory` 解它内嵌的预览图，缩到 480px 存成 jpg 给图库当缩略图。
   * （`BitmapFactory` 对 ARW 恰好能读出那张嵌入预览——之前误存 24MB 假 jpg 就是它的副作用。）
   */
  private fun persistCapturedRaw(raw: ByteArray, notify: Boolean = true): Map<String, Any?> {
    val stamp = System.currentTimeMillis()
    val name = "sony-camera-$stamp.arw"
    val output = File(context.cacheDir, name)
    FileOutputStream(output).use { it.write(raw) }

    var width = 0
    var height = 0
    var thumbUri: String? = null
    runCatching {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
      width = maxOf(0, bounds.outWidth)
      height = maxOf(0, bounds.outHeight)
      if (width > 0 && height > 0) {
        var sample = 1
        while (width / sample > RAW_THUMB_EDGE || height / sample > RAW_THUMB_EDGE) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val preview = BitmapFactory.decodeByteArray(raw, 0, raw.size, opts) ?: return@runCatching
        val thumbFile = File(context.cacheDir, "sony-raw-thumb-$stamp.jpg")
        FileOutputStream(thumbFile).use { stream ->
          preview.compress(Bitmap.CompressFormat.JPEG, 80, stream)
        }
        preview.recycle()
        thumbUri = Uri.fromFile(thumbFile).toString()
      }
    }.onFailure { trace("raw preview decode failed: ${it.message ?: "unknown"}") }

    val payload = buildMap<String, Any?> {
      put("uri", Uri.fromFile(output).toString())
      put("width", width)
      put("height", height)
      put("fileName", name)
      put("mimeType", "image/x-sony-arw")
      put("raw", true)
      if (thumbUri != null) put("thumbUri", thumbUri)
    }
    if (notify) listeners.forEach { it.onPhotoCaptured(payload) }
    trace("captured RAW persisted bytes=${raw.size} preview=${width}x$height thumb=${thumbUri != null}")
    return payload
  }

  /**
   * JPEG 取完之后，句柄上可能还挂着同一张的 RAW（机身在 RAW+JPEG 模式）。
   *
   * 只读"确认是 RAW"的那一个对象：万一后面换成下一张的 JPEG，提前读走会把它吃掉。
   */
  private fun takeFollowUpRaw(active: SonyPtpTransport) {
    val info = runCatching { active.objectInfo(active.capturedImageHandle) }.getOrNull() ?: return
    if (!SonyPtpCodec.isSonyRawObjectFormat(info.format)) return
    trace("follow-up object is RAW (${info.name}, ${info.size} bytes); fetching")
    val raw = runCatching { active.takeObjectPayload(active.capturedImageHandle) }.getOrNull() ?: return
    runCatching { persistCapturedRaw(raw) }
      .onFailure { trace("persist RAW failed: ${it.message ?: "unknown"}") }
  }

  fun close() {
    disconnectBlocking()
    cameraNetwork.release()
    runCatching { context.unregisterReceiver(usbReceiver) }
    executor.shutdownNow()
    streamExecutor.shutdownNow()
  }

  private fun requestPermission(attached: UsbDevice) {
    if (!permissionRequestPending.compareAndSet(false, true)) {
      trace("USB permission request coalesced")
      return
    }
    trace("requesting Android USB permission ${describeDevice(attached)}")
    updateState("permission_required", "Allow this app to use the attached Sony camera.")
    val intent = Intent(permissionAction).setPackage(context.packageName)
    val pending = PendingIntent.getBroadcast(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )
    usbManager.requestPermission(attached, pending)
  }

  private fun isCaptureUnsupported(error: SonyPtpException): Boolean =
    error.message?.startsWith(SonyPtpTransport.CAPTURE_UNSUPPORTED_PREFIX) == true

  private fun isLiveViewUnsupported(error: SonyPtpException): Boolean =
    error.message?.startsWith(LIVE_VIEW_UNSUPPORTED_PREFIX) == true

  private fun fail(error: Throwable) {
    trace("failure ${error::class.java.simpleName}: ${error.message ?: "no message"}")
    val lostScalarConnection = scalarTransport != null && isConnectionLoss(error)
    streaming.set(false)
    stopBodyShutterWatcher()
    runCatching { transport?.close() }
    transport = null
    val hadScalar = scalarTransport != null
    runCatching { scalarTransport?.close() }
    scalarTransport = null
    scalarDescriptor = null
    if (hadScalar) cameraNetwork.release()
    if (lostScalarConnection) {
      updateState("reconnecting", "Sony camera connection was lost. Reconnecting…")
      scheduleScalarReconnect()
    } else {
      updateState("error", error.message ?: "Sony camera connection failed.")
    }
  }

  private fun scheduleScalarReconnect() {
    if (!liveViewRequested.get()) {
      updateState("disconnected", "Sony camera disconnected. Turn it on and tap Retry.")
      return
    }
    if (!scalarReconnectScheduled.compareAndSet(false, true)) {
      trace("Scalar reconnect coalesced: retry already scheduled")
      return
    }
    trace("Scalar reconnect scheduled delayMs=$SCALAR_RECONNECT_DELAY_MS")
    executor.execute {
      try {
        SystemClock.sleep(SCALAR_RECONNECT_DELAY_MS)
      } finally {
        scalarReconnectScheduled.set(false)
      }
      enqueueScalarConnect()
    }
  }

  private fun isConnectionLoss(error: Throwable): Boolean {
    var current: Throwable? = error
    while (current != null) {
      val type = current::class.java.simpleName
      val detail = current.message.orEmpty().lowercase(Locale.US)
      if (
        type in setOf("SocketException", "SocketTimeoutException", "EOFException", "ConnectException") ||
        detail.contains("connection abort") ||
        detail.contains("connection reset") ||
        detail.contains("broken pipe") ||
        detail.contains("unexpected end of stream")
      ) return true
      current = current.cause
    }
    return false
  }

  private fun updateState(next: String, nextMessage: String?): Map<String, Any?> {
    state = next
    message = nextMessage
    trace("state=$next message=${nextMessage ?: "none"}")
    val payload = statePayload()
    listeners.forEach { it.onStateChanged(payload) }
    return payload
  }

  private fun findSonyPtpDevice(): UsbDevice? = usbManager.deviceList.values.firstOrNull(::isSonyPtp)

  private fun isSonyPtp(candidate: UsbDevice): Boolean {
    if (candidate.vendorId != SONY_VENDOR_ID) return false
    return (0 until candidate.interfaceCount).any { index -> candidate.getInterface(index).interfaceClass == 6 }
  }

  private fun payloadFor(state: String, message: String?, attached: UsbDevice?): Map<String, Any?> {
    val result = linkedMapOf<String, Any?>("state" to state)
    if (message != null) result["message"] = message
    result["diagnostics"] = diagnosticSnapshot()
    // 取景是否可用：true 表示这次会话支持 USB 实时取景（有的机身不支持，但快门/回传正常）
    result["liveViewSupported"] = !liveViewUnsupported
    // 取景帧率：只在这一秒真的收到帧时才有意义，停流后归零，别让界面停在旧值
    result["fps"] = if (streaming.get()) lastFps else 0.0
    // 只读参数（快门/光圈/ISO/EV/白平衡/电量）：取景中是帧线程顺手读到的，非取景时由轮询填
    if (lastExposureSnapshot.isNotEmpty()) result["exposure"] = lastExposureSnapshot
    if (attached != null) {
      result["device"] = mapOf(
        "vendorId" to attached.vendorId,
        "productId" to attached.productId,
        "deviceName" to attached.deviceName,
        "manufacturerName" to runCatching { attached.manufacturerName }.getOrNull(),
        "productName" to runCatching { attached.productName }.getOrNull(),
        "model" to (runCatching { attached.productName }.getOrNull() ?: "Sony PTP Camera"),
        "protocol" to "sony_camera_control_ptp2",
        "transport" to "usb",
        "connectionMode" to "usb",
        "certification" to "capability_detected",
        // Derived from the camera's own GetDeviceInfo response, not from a model name or
        // from what this package happens to implement.
        "capabilities" to SonyCapabilityResolver.resolve(
          transport?.deviceInfo,
          protocol = "sony_camera_control_ptp2",
          transport = "usb",
        ),
      )
    } else if (scalarDescriptor != null || scalarTransport != null) {
      val scalar = scalarDescriptor
      result["device"] = mapOf(
        "vendorId" to SONY_VENDOR_ID,
        "productId" to 0,
        "deviceName" to "Sony Wi-Fi Camera",
        "model" to (scalar?.modelName ?: "Sony Scalar Camera"),
        "protocol" to "sony_scalar_webapi_v1",
        "transport" to "scalar_http",
        "connectionMode" to "wifi_direct",
        "certification" to "capability_detected",
        // ScalarWebAPI advertises capability as a method list rather than PTP codes, so
        // each flag is gated on the camera actually listing the method that implements it.
        "capabilities" to scalarCapabilities(),
      )
    }
    return result
  }

  /** Capabilities for the active ScalarWebAPI session, gated on its advertised API list. */
  private fun scalarCapabilities(): Map<String, Any?> {
    val scalar = scalarTransport
    fun advertises(method: String) = scalar?.supports(method) == true
    val liveView = advertises("startLiveview") || scalar != null
    val stillCapture = advertises("actTakePicture")
    val movie = advertises("startMovieRec")
    val media = advertises("getContentList")
    val categories = buildList {
      add("connection")
      if (liveView) add("live_view")
      if (stillCapture) add("still_capture")
      if (advertises("setTouchAFPosition") || advertises("actHalfPressShutter")) add("focus")
      if (movie) add("movie")
      if (media) add("media")
      add("health")
    }
    return mapOf(
      "protocols" to listOf("sony_scalar_webapi_v1"),
      "transports" to listOf("scalar_http"),
      "connectionModes" to listOf("wifi_direct"),
      "categories" to categories,
      "features" to mapOf(
        "liveView" to liveView,
        "stillCapture" to stillCapture,
        "imageTransfer" to stillCapture,
        "properties" to false,
        "movieRecording" to movie,
        "mediaBrowser" to media,
        "events" to advertises("getEvent"),
        "halfPress" to advertises("actHalfPressShutter"),
        "touchFocus" to advertises("setTouchAFPosition"),
      ),
    )
  }

  private fun trace(event: String) {
    val now = System.currentTimeMillis()
    val entry = String.format(Locale.US, "%1\$tT.%1\$tL %2\$s", now, event)
    Log.i(TAG, entry)
    synchronized(diagnostics) {
      diagnostics.addLast(entry)
      while (diagnostics.size > MAX_DIAGNOSTICS) diagnostics.removeFirst()
      diagnosticsPreferences.edit().putString(DIAGNOSTICS_KEY, diagnostics.joinToString("\n")).apply()
    }
  }

  private fun diagnosticSnapshot(): List<String> = synchronized(diagnostics) { diagnostics.toList().takeLast(MAX_PAYLOAD_DIAGNOSTICS) }

  /**
   * The full retained trace, not the truncated copy embedded in state payloads.
   *
   * Entries are already sanitised at the point of writing: the transport traces operation
   * codes, sizes, and timings, never Wi-Fi credentials, serial numbers, or image bytes.
   */
  fun diagnosticsSnapshot(): Map<String, Any?> {
    val entries = synchronized(diagnostics) { diagnostics.toList() }
    val result = linkedMapOf<String, Any?>("entries" to entries)
    when {
      scalarTransport != null -> {
        result["protocol"] = "sony_scalar_webapi_v1"
        result["transport"] = "scalar_http"
      }
      transport != null -> {
        result["protocol"] = "sony_camera_control_ptp2"
        result["transport"] = "usb"
      }
    }
    return result
  }

  fun clearDiagnostics() {
    synchronized(diagnostics) {
      diagnostics.clear()
      diagnosticsPreferences.edit().remove(DIAGNOSTICS_KEY).apply()
    }
  }

  private fun describeDevice(candidate: UsbDevice): String {
    val interfaces = (0 until candidate.interfaceCount).joinToString(",") { index ->
      val usbInterface = candidate.getInterface(index)
      "${usbInterface.interfaceClass}/${usbInterface.interfaceSubclass}/${usbInterface.interfaceProtocol}:ep${usbInterface.endpointCount}"
    }
    return "%04x:%04x interfaces=[%s]".format(candidate.vendorId, candidate.productId, interfaces)
  }
}

private fun Intent.usbDevice(): UsbDevice? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
  getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
} else {
  @Suppress("DEPRECATION")
  getParcelableExtra(UsbManager.EXTRA_DEVICE)
}
