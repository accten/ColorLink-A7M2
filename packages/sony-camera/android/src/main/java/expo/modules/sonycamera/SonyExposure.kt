package expo.modules.sonycamera

import kotlin.math.abs

/**
 * Turns Sony's raw property values into the short strings a monitor shows.
 *
 * The encodings are not obvious:
 * - shutter speed (0xD20D) is `numerator << 16 | denominator`, and some bodies report
 *   10-based pairs (`300/10`) that mean `30/1`;
 * - ISO (0xD21E) keeps the value in the low 24 bits and repurposes the top byte as the
 *   multi-frame-noise-reduction flag, with `0xFFFFFF` meaning auto;
 * - aperture (0x5007) is hundredths of an f-number;
 * - exposure compensation (0x5010) is thousandths of a stop, stored as a signed value.
 *
 * Everything here is pure so it can be unit tested without a camera attached.
 */
internal object SonyExposure {
  fun shutterSpeed(raw: Long): String? {
    if (raw <= 0) return null
    var numerator = (raw shr 16).toInt()
    var denominator = (raw and 0xFFFF).toInt()
    // Some bodies hand back a plain denominator (250 for 1/250 s).
    if (numerator == 0) {
      numerator = 1
      denominator = raw.toInt()
    }
    if (denominator <= 0) return null
    // Sony reports long exposures as 300/10, 250/10, ... meaning 30 s, 25 s, ...
    if (denominator == 10 && numerator % 10 == 0) {
      numerator /= 10
      denominator = 1
    }
    return if (denominator == 1) "${numerator}s" else "$numerator/$denominator"
  }

  fun aperture(raw: Long): String? {
    if (raw <= 0) return null
    return if (raw % 100 == 0L) "f/${raw / 100}" else "f/%.1f".format(raw / 100.0)
  }

  fun iso(raw: Long): String? {
    val base = raw and 0xFFFFFF
    if (base == 0L) return null
    if (base == 0xFFFFFFL) return "自动"
    return base.toString()
  }

  /**
   * [raw] is thousandths of a stop. The transport does not know whether the body described the
   * property as `INT16` or `INT32`, so normalise both negative encodings here.
   */
  fun exposureCompensation(raw: Long): String? {
    val signed = when {
      raw in 0xFFFF8000L..0xFFFFFFFFL -> raw - (1L shl 32)
      raw in 0x8000L..0xFFFFL -> raw - (1L shl 16)
      else -> raw
    }
    if (signed == 0L) return "0"
    val text = "%.1f".format(abs(signed / 1000.0))
    val sign = if (signed > 0) "+" else "-"
    val trimmed = if (text.endsWith(".0")) text.dropLast(2) else text
    return "$sign$trimmed"
  }

  fun whiteBalance(raw: Long): String? = when (raw) {
    0x0001L -> "自动"
    0x0002L -> "日光"
    0x0003L -> "荧光灯"
    0x0004L -> "白炽灯"
    0x0005L -> "闪光灯"
    0x0006L -> "阴天"
    0x0007L -> "阴影"
    else -> null
  }

  fun batteryPercent(raw: Long): Int? = if (raw in 0..100) raw.toInt() else null
}
