package expo.modules.sonycamera

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
 *
 * 这份清单是"这台机身到底支持什么"的唯一来源：A7M2 的 `GetDeviceInfo` 会报 16 条标准操作，
 * 但 D215/D2C1/D2C2 这些只有在这里才出现。
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
  // 一台机身最多几十条扩展码；超过这个数一定是包错了，别为它分配内存。
  val maxVendorCodes = 512
  var offset = 2
  fun readU16(at: Int): Int =
    (data[at].toInt() and 0xFF) or ((data[at + 1].toInt() and 0xFF) shl 8)

  fun readU32(at: Int): Int {
    var value = 0L
    for (index in 0 until 4) {
      value = value or ((data[at + index].toLong() and 0xFFL) shl (8 * index))
    }
    return value.toInt()
  }

  fun readCodeSet(): List<Int> {
    if (offset + 4 > data.size) return emptyList()
    val count = readU32(offset)
    offset += 4
    // 计数不合理就当这段没交（机身偶尔会在重试时回一段短包）。
    // 必须用 Long 比较：count 是 UINT32，count*2 用 Int 会溢出成负数，
    // 于是"2GB 的数组"能通过检查，接着 ArrayList(count) 直接把进程打死。
    if (count <= 0 || count > maxVendorCodes) return emptyList()
    if (offset.toLong() + count.toLong() * 2L > data.size.toLong()) return emptyList()
    val codes = ArrayList<Int>(count)
    repeat(count) {
      codes.add(readU16(offset))
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
