package expo.modules.sonycamera

/**
 * Parser for Sony's `SDIDevicePropInfo Dataset Array`, the payload returned by
 * `SDIO_GetAllExtDevicePropInfo` (0x9209).
 *
 * Array layout:
 * ```
 * Num of Elements            UINT64
 * SDIExtDevicePropInfo[0 .. Num of Elements - 1]
 * ```
 *
 * Each `SDIExtDevicePropInfo` record:
 * ```
 * Device Property Code       UINT16
 * DataType                   UINT16
 * GetSet                     UINT8    0 = read only, 1 = the initiator can set the value
 * IsEnabled                  UINT8    0 = false, 1 = true, 2 = display only
 * Factory Default Value      variable, sized by DataType
 * Current Value              variable, sized by DataType
 * Form Flag                  UINT8    0 = none, 1 = range, 2 = enumeration
 *   range form:              minimum, maximum, step   each sized by DataType
 *   enumeration form:        UINT16 count + values    (settable list)
 *                            UINT16 count + values    (supported list)
 * ```
 *
 * The previous implementation searched the payload for a two-byte property code and
 * assumed a fixed offset to the current value. That could match bytes inside an earlier
 * record's enumeration list and return an unrelated value, and it could not enumerate.
 * This parser walks records sequentially so every offset is derived from the record that
 * precedes it.
 */
internal object SonyPtpProperties {
  /** Sony reports the element count as a UINT64; no camera returns anything near this. */
  private const val MAX_ELEMENTS = 4_096

  /** Guards against a corrupt count field turning into a multi-gigabyte allocation. */
  private const val MAX_ARRAY_ELEMENTS = 65_536

  fun parseAll(data: ByteArray): List<SonyDeviceProperty> = scan(data).parsed

  /**
   * Walks the array and reports where it stopped.
   *
   * A body whose blob does not fit the documented layout used to yield an empty list with no
   * explanation, which is indistinguishable from "the camera has no properties". The caller
   * needs the offset and the surrounding bytes to fix the layout, so return them.
   */
  fun scan(data: ByteArray): SonyPropBlobScan {
    val reader = SonyPtpReader(data)
    val properties = ArrayList<SonyDeviceProperty>()
    var declared = 0L
    return try {
      declared = reader.u64()
      val count = if (declared < 0 || declared > MAX_ELEMENTS) MAX_ELEMENTS.toLong() else declared
      var index = 0L
      while (index < count && reader.remaining() > 0) {
        properties.add(parseRecord(reader))
        index += 1
      }
      SonyPropBlobScan(declared, properties, null, -1, "")
    } catch (error: SonyPtpParseException) {
      val at = reader.position()
      SonyPropBlobScan(
        declared = declared,
        parsed = properties,
        failure = error.message,
        failureOffset = at,
        window = hexWindow(data, at),
      )
    }
  }

  private fun hexWindow(data: ByteArray, at: Int): String {
    val from = (at - 8).coerceAtLeast(0)
    val to = (at + 24).coerceAtMost(data.size)
    if (from >= to) return ""
    return data.copyOfRange(from, to).joinToString("") { "%02X".format(it) }
  }

  fun find(properties: List<SonyDeviceProperty>, code: Int): SonyDeviceProperty? =
    properties.firstOrNull { it.code == code }

  /**
   * Last-resort lookup: find one record by walking the payload byte by byte.
   *
   * The sequential walk depends on every preceding record decoding at exactly the documented
   * width. One unknown datatype or one extra enumeration list shifts the cursor and every
   * following property becomes unreachable - which is what happened on the ILCE-7M2. The
   * record header itself is still unambiguous, so scan for it, then read the current value at
   * the offset the header implies.
   *
   * A false positive needs all of: the exact 16-bit property code, a datatype with a known
   * width, room for both values, and a current value inside [maxValue]. Callers pass the range
   * the property can legitimately hold, which makes a wrong match very unlikely.
   */
  fun findValueByScan(data: ByteArray, code: Int, maxValue: Long = Long.MAX_VALUE): Long? {
    if (data.size < 12) return null
    val target = code and 0xFFFF
    var offset = 8
    while (offset + 6 <= data.size) {
      val candidate = (data[offset].toInt() and 0xFF) or ((data[offset + 1].toInt() and 0xFF) shl 8)
      if (candidate == target) {
        val dataType = (data[offset + 2].toInt() and 0xFF) or ((data[offset + 3].toInt() and 0xFF) shl 8)
        val width = when (dataType) {
          0x0001, 0x0002 -> 1
          0x0003, 0x0004 -> 2
          0x0005, 0x0006 -> 4
          0x0007, 0x0008 -> 8
          else -> 0
        }
        // 6 = code(2) + type(2) + getSet(1) + enabled(1); default value sits before current
        val currentAt = offset + 6 + width
        if (width in 1..8 && currentAt + width <= data.size) {
          var value = 0L
          for (index in 0 until width) {
            value = value or ((data[currentAt + index].toLong() and 0xFFL) shl (8 * index))
          }
          if (value in 0..maxValue) return value
        }
      }
      offset += 1
    }
    return null
  }

  /** Convenience for the readiness properties the transport polls (D213, D215, D221). */
  fun scalar(properties: List<SonyDeviceProperty>, code: Int): Long? =
    (find(properties, code)?.currentValue as? Long)

  private fun parseRecord(reader: SonyPtpReader): SonyDeviceProperty {
    val code = reader.u16()
    val dataType = reader.u16()
    val getSet = reader.u8()
    val isEnabled = reader.u8()
    val defaultValue = reader.value(dataType)
    val currentValue = reader.value(dataType)
    val formFlag = reader.u8()

    var range: SonyPropertyRange? = null
    var settableValues = emptyList<Any?>()
    var supportedValues = emptyList<Any?>()

    when (formFlag) {
      FORM_RANGE -> {
        range = SonyPropertyRange(
          minimum = reader.value(dataType),
          maximum = reader.value(dataType),
          step = reader.value(dataType),
        )
      }
      FORM_ENUMERATION -> {
        settableValues = reader.valueList(dataType)
        // 少数新机型会在枚举列表后面再跟一份"支持列表"。判断依据是参考实现的规则：
        // 接下来的 UINT16 必须**像一个数量**（< 0x0200），否则它就是下一条记录的属性码
        // （0x5xxx / 0xDxxx）。用"还有 2 字节就再读一份"会把下一条记录的属性码当成数量，
        // 于是整包从第一条枚举记录之后就全错位 —— A7M2 的 1118 字节属性数组正是这样被读空的。
        supportedValues = if (reader.remaining() >= 2 && reader.peekU16() < MAX_ENUMERATION_COUNT) {
          reader.valueList(dataType)
        } else {
          emptyList()
        }
      }
    }

    return SonyDeviceProperty(
      code = code,
      dataType = dataType,
      writable = getSet == 1,
      availability = when (isEnabled) {
        0 -> SonyPropertyAvailability.DISABLED
        2 -> SonyPropertyAvailability.DISPLAY_ONLY
        else -> SonyPropertyAvailability.ENABLED
      },
      defaultValue = defaultValue,
      currentValue = currentValue,
      range = range,
      settableValues = settableValues,
      supportedValues = supportedValues,
    )
  }

  private const val FORM_RANGE = 0x01
  private const val FORM_ENUMERATION = 0x02

  /** 枚举值的数量上限：再大就不是"数量"，而是下一条记录的属性码 */
  private const val MAX_ENUMERATION_COUNT = 0x0200

  /** Reads a `UINT16` count followed by that many DataType-sized values. */
  private fun SonyPtpReader.valueList(dataType: Int): List<Any?> {
    val count = u16()
    if (count > MAX_ARRAY_ELEMENTS) throw SonyPtpParseException("Enumeration count $count is implausible.")
    return (0 until count).map { value(dataType) }
  }
}

internal enum class SonyPropertyAvailability {
  /** `IsEnabled = 0x00`. Supported by the body but invalid in the current mode. */
  DISABLED,

  /** `IsEnabled = 0x01`. Readable, and writable when `writable` is also true. */
  ENABLED,

  /** `IsEnabled = 0x02`. Indication only; the value must not be written. */
  DISPLAY_ONLY,
}

internal data class SonyPropertyRange(val minimum: Any?, val maximum: Any?, val step: Any?)

/**
 * One decoded device property.
 *
 * [currentValue] is a [Long] for every integer datatype, a [String] for `STR`, a
 * `List<Any?>` for array datatypes, and a hex [String] for the 128-bit datatypes.
 */
internal data class SonyDeviceProperty(
  val code: Int,
  val dataType: Int,
  val writable: Boolean,
  val availability: SonyPropertyAvailability,
  val defaultValue: Any?,
  val currentValue: Any?,
  val range: SonyPropertyRange?,
  val settableValues: List<Any?>,
  val supportedValues: List<Any?>,
) {
  val enabled: Boolean get() = availability != SonyPropertyAvailability.DISABLED
}

internal class SonyPtpParseException(message: String) : Exception(message)

/** Result of walking a `0x9209` payload: what parsed, and where it stopped if it did not. */
internal data class SonyPropBlobScan(
  val declared: Long,
  val parsed: List<SonyDeviceProperty>,
  val failure: String?,
  val failureOffset: Int,
  /** Hex around the failure offset, so a wrong layout can be diagnosed from a log line. */
  val window: String,
)

/**
 * Little-endian cursor over a PTP payload.
 *
 * Every read is bounds-checked. Advancing the cursor by the true size of each field is
 * what makes sequential record parsing possible, so an unreadable field must stop the
 * walk rather than silently return a zero and desynchronise every following record.
 */
internal class SonyPtpReader(private val data: ByteArray, private var offset: Int = 0) {
  fun remaining(): Int = data.size - offset

  /** Current cursor position, for diagnostics when a record cannot be decoded. */
  fun position(): Int = offset

  fun u8(): Int = read(1) { data[it].toInt() and 0xFF }

  fun u16(): Int = read(2) {
    (data[it].toInt() and 0xFF) or ((data[it + 1].toInt() and 0xFF) shl 8)
  }

  /** Read the next UINT16 without consuming it: used to tell a list count from the next code. */
  fun peekU16(): Int {
    if (offset + 2 > data.size) throw SonyPtpParseException("PTP payload ended after $offset of ${data.size} bytes.")
    return (data[offset].toInt() and 0xFF) or ((data[offset + 1].toInt() and 0xFF) shl 8)
  }

  fun u32(): Long = read(4) {
    var result = 0L
    for (index in 3 downTo 0) result = (result shl 8) or (data[it + index].toLong() and 0xFF)
    result
  }

  fun u64(): Long = read(8) {
    var result = 0L
    for (index in 7 downTo 0) result = (result shl 8) or (data[it + index].toLong() and 0xFF)
    result
  }

  /**
   * Reads one value of [dataType] and advances past it.
   *
   * Returns `null` for datatypes this parser does not decode, but only after advancing
   * the cursor by the correct number of bytes. An unknown datatype of known width is
   * recoverable; an unknown width is not.
   */
  fun value(dataType: Int): Any? = when (dataType) {
    DATATYPE_INT8 -> signed(u8().toLong(), 8)
    DATATYPE_UINT8 -> u8().toLong()
    DATATYPE_INT16 -> signed(u16().toLong(), 16)
    DATATYPE_UINT16 -> u16().toLong()
    DATATYPE_INT32 -> signed(u32(), 32)
    DATATYPE_UINT32 -> u32()
    // A UINT64 above Long.MAX_VALUE is returned as its two's-complement Long. No Sony
    // device property uses that range; the cursor position is what matters here.
    DATATYPE_INT64, DATATYPE_UINT64 -> u64()
    DATATYPE_INT128, DATATYPE_UINT128 -> hex(16)
    DATATYPE_STRING -> string()
    else ->
      if (dataType and ARRAY_FLAG != 0) array(dataType and ARRAY_FLAG.inv())
      else throw SonyPtpParseException("Unknown PTP datatype 0x%04X.".format(dataType))
  }

  /** PTP string: `UINT8` character count, then that many UTF-16LE units including the null. */
  private fun string(): String {
    val characters = u8()
    if (characters == 0) return ""
    val bytes = read(characters * 2) { start -> data.copyOfRange(start, start + characters * 2) }
    return String(bytes, Charsets.UTF_16LE).trimEnd('\u0000', ' ')
  }

  /** PTP array: `UINT32` element count, then that many elements of the element datatype. */
  private fun array(elementType: Int): List<Any?> {
    val count = u32()
    if (count < 0 || count > MAX_ELEMENTS) throw SonyPtpParseException("Array length $count is implausible.")
    return (0 until count).map { value(elementType) }
  }

  private fun hex(bytes: Int): String = read(bytes) { start ->
    (0 until bytes).joinToString("") { "%02X".format(data[start + bytes - 1 - it]) }
  }

  private fun signed(raw: Long, bits: Int): Long {
    val signBit = 1L shl (bits - 1)
    return if (raw and signBit != 0L) raw - (1L shl bits) else raw
  }

  private fun <T> read(size: Int, decode: (Int) -> T): T {
    if (size < 0 || offset + size > data.size) {
      throw SonyPtpParseException("PTP payload ended after $offset of ${data.size} bytes.")
    }
    val start = offset
    offset += size
    return decode(start)
  }

  private companion object {
    const val MAX_ELEMENTS = 65_536L
    const val ARRAY_FLAG = 0x4000

    const val DATATYPE_INT8 = 0x0001
    const val DATATYPE_UINT8 = 0x0002
    const val DATATYPE_INT16 = 0x0003
    const val DATATYPE_UINT16 = 0x0004
    const val DATATYPE_INT32 = 0x0005
    const val DATATYPE_UINT32 = 0x0006
    const val DATATYPE_INT64 = 0x0007
    const val DATATYPE_UINT64 = 0x0008
    const val DATATYPE_INT128 = 0x0009
    const val DATATYPE_UINT128 = 0x000A
    const val DATATYPE_STRING = 0xFFFF
  }
}
