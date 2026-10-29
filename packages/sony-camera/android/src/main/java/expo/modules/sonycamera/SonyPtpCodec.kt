package expo.modules.sonycamera

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * PTP 容器的编解码，以及 Sony `GetObject(0x1009)` 返回数据段的还原。
 *
 * 放在独立文件里是为了让它保持"纯 Kotlin"：不 import 任何 android.*，
 * 这样这些解析逻辑可以在普通 JVM 上跑单测，不用等真机。
 */
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
    val suggestedOffset = readU32(data, 0).toInt()
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
   * - 其他：返回原始字节，交给上层判断（总比把一次成功的传输丢掉好）。
   */
  fun extractSonyObjectPayload(data: ByteArray): ByteArray? {
    if (data.isEmpty()) return null
    if (data.size >= 4 && isObjectMagic(data, 0)) return data
    parseSonyJpegData(data)?.let { return it }
    if (data.size >= 4) {
      val offset = readU32(data, 0).toInt()
      if (offset in 1 until data.size - 3 && isObjectMagic(data, offset)) {
        return data.copyOfRange(offset, data.size)
      }
    }
    return data
  }

  /**
   * PTP 对象格式是不是 JPEG。
   *
   * 机身设成 RAW+JPEG 时，`0xFFFFC001` 这个句柄会**先后交出两个对象**：
   * 先 `format=0x3801` 的 `DSC00256.JPG`，读完再问就变成 `format=0xB101` 的 `DSC00256.ARW`
   * （实测 OPPO Pad 4 Pro + ILCE-7M2）。所以"再读一次"拿到的不一定是同一张照片，
   * 落盘前必须先看格式，否则会把 24MB 的 ARW 存成 .jpg。
   */
  fun isJpegObjectFormat(format: Int): Boolean = format == OBJECT_FORMAT_JPEG

  /** Sony 的 ARW 对象格式码（诊断用；我们不处理 RAW）。 */
  fun isSonyRawObjectFormat(format: Int): Boolean = format == OBJECT_FORMAT_SONY_RAW

  private const val OBJECT_FORMAT_JPEG = 0x3801
  private const val OBJECT_FORMAT_SONY_RAW = 0xB101

  /**
   * JPEG 是否"已经写完"：SOI 开头，且末尾一段窗口里有 EOI（`FF D9`）。
   *
   * 用途：机身快门那条路是先收到 `0xC201` 事件再去读对象，相机此时可能还在往卡里写，
   * 读回来的是半截字节。半截 JPEG 仍能被 BitmapFactory 读出宽高，落盘后就是一张坏图，
   * 所以读之前先判断完整性，不完整就退避重读。
   */
  fun isCompleteJpeg(data: ByteArray, tailWindow: Int = 64): Boolean {
    if (data.size < 4) return false
    if (data[0] != 0xFF.toByte() || data[1] != 0xD8.toByte()) return false
    val from = maxOf(2, data.size - tailWindow.coerceAtLeast(2))
    for (index in data.size - 2 downTo from) {
      if (data[index] == 0xFF.toByte() && data[index + 1] == 0xD9.toByte()) return true
    }
    return false
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

  private fun readU32(data: ByteArray, at: Int): Long {
    var value = 0L
    for (index in 0 until 4) {
      value = value or ((data[at + index].toLong() and 0xFFL) shl (8 * index))
    }
    return value
  }
}
