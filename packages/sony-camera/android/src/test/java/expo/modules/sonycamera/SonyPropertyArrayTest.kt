package expo.modules.sonycamera

import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for the two parsers that stand between the camera and the capture logic:
 * the `0x9209` property array (Sony DPD records) and the `0x9202` vendor code list.
 *
 * These exist because the ILCE-7M2 body is the only hardware available and it is not always
 * plugged in: the layout rules have to be provable from the documented format, and one bad
 * record must not silently hide every later property.
 */
class SonyPropertyArrayTest {
  @Test
  fun parsesSequentialDpdRecords() {
    val blob = blobOf(
      record(0xD215, DATATYPE_UINT16, factory = 0, currentValue = 0x8001),
      record(0xD213, DATATYPE_UINT8, factory = 0, currentValue = 2),
      record(0x5013, DATATYPE_UINT32, factory = 1, currentValue = 1, form = FORM_ENUMERATION, values = longArrayOf(1, 2, 3)),
    )

    val scan = SonyPtpProperties.scan(blob)

    assertEquals(null, scan.failure)
    assertEquals(3, scan.parsed.size)
    assertEquals(0x8001L, SonyPtpProperties.scalar(scan.parsed, 0xD215))
    assertEquals(2L, SonyPtpProperties.scalar(scan.parsed, 0xD213))
    // The enumeration belongs to 0x5013 and must not desynchronise anything after it.
    assertEquals(1L, SonyPtpProperties.scalar(scan.parsed, 0x5013))
  }

  @Test
  fun keepsEarlierRecordsWhenALaterRecordIsTruncated() {
    val complete = record(0xD215, DATATYPE_UINT16, factory = 0, currentValue = 0x8000)
    // Claim two records but only deliver one and a half: the first record must still be usable.
    val truncated = blobDeclaring(2, complete).copyOf(8 + complete.size + 3)

    val scan = SonyPtpProperties.scan(truncated)

    assertEquals(1, scan.parsed.size)
    assertEquals(0x8000L, SonyPtpProperties.scalar(scan.parsed, 0xD215))
    assertTrue(scan.failure != null)
    assertTrue(scan.failureOffset > 0)
  }

  @Test
  fun reportsWhereTheSequentialWalkStopped() {
    // An unknown datatype has no width, so the walk cannot continue past it.
    val blob = blobOf(
      rawRecord(0x5004, 0x0040, ByteArray(8)),
      record(0xD215, DATATYPE_UINT16, factory = 0, currentValue = 0x8001),
    )

    val scan = SonyPtpProperties.scan(blob)

    assertEquals(0, scan.parsed.size)
    assertTrue(scan.failure!!.contains("0x0040"))
    assertTrue(scan.window.isNotEmpty())
  }

  @Test
  fun byteScanFindsAPropertyBehindAnUnparsableRecord() {
    // This is the ILCE-7M2 situation: the sequential walk dies early, but the record header
    // for D215 is still intact later in the payload.
    val blob = blobOf(
      rawRecord(0x5004, 0x0040, ByteArray(8)),
      record(0xD215, DATATYPE_UINT16, factory = 0, currentValue = 0x8001),
    )

    assertEquals(0x8001L, SonyPtpProperties.findValueByScan(blob, 0xD215, 0x8002))
  }

  @Test
  fun byteScanRejectsValuesOutsideThePlausibleRange() {
    // A property code can appear inside an enumeration list; the value range is what makes a
    // match believable, so an implausible current value must not be reported.
    val blob = blobOf(record(0xD215, DATATYPE_UINT16, factory = 0, currentValue = 0xFFFF))

    assertNull(SonyPtpProperties.findValueByScan(blob, 0xD215, 0x8002))
  }

  @Test
  fun byteScanIgnoresUnknownDatatypes() {
    val bytes = ByteArrayOutputStream()
    writeU64(bytes, 1)
    writeU16(bytes, 0xD215)
    writeU16(bytes, 0x00FF) // not a PTP datatype
    writeU16(bytes, 0)
    writeU16(bytes, 0x8001)

    assertNull(SonyPtpProperties.findValueByScan(bytes.toByteArray(), 0xD215, 0x8002))
  }

  @Test
  fun parsesVendorCodeListFromExtDeviceInfo() {
    // 0x9202 payload: UINT16 version, AUINT16 device properties, AUINT16 controls,
    // every code classified by its top three bits.
    val bytes = ByteArrayOutputStream()
    writeU16(bytes, 0x00C8)
    writeU32(bytes, 3L)
    writeU16(bytes, 0xD215)
    writeU16(bytes, 0x9207.toInt())
    writeU16(bytes, 0xC201.toInt())
    writeU32(bytes, 2L)
    writeU16(bytes, 0xD2C1)
    writeU16(bytes, 0x9209.toInt())

    val codes = parseSonyVendorCodes(bytes.toByteArray())

    assertEquals(setOf(0xD215, 0xD2C1), codes.properties)
    assertEquals(setOf(0x9207, 0x9209), codes.operations)
    assertEquals(setOf(0xC201), codes.events)
  }

  @Test
  fun ignoresVendorCodeListWithAnImpossibleCount() {
    val bytes = ByteArrayOutputStream()
    writeU16(bytes, 0x00C8)
    writeU32(bytes, 0x7FFFFFFFL)
    writeU16(bytes, 0xD215)

    assertEquals(SonyVendorCodes(), parseSonyVendorCodes(bytes.toByteArray()))
  }

  private fun blobOf(vararg records: ByteArray): ByteArray = blobDeclaring(records.size, *records)

  private fun blobDeclaring(declaredCount: Int, vararg records: ByteArray): ByteArray {
    val out = ByteArrayOutputStream()
    // 8 bytes before the first record: a 32-bit element count followed by a 32-bit zero,
    // which the reader consumes as one little-endian UINT64.
    writeU64(out, declaredCount.toLong())
    records.forEach { out.write(it) }
    return out.toByteArray()
  }

  /** A record header followed by arbitrary bytes, for datatypes the writer cannot encode. */
  private fun rawRecord(code: Int, dataType: Int, body: ByteArray): ByteArray {
    val out = ByteArrayOutputStream()
    writeU16(out, code)
    writeU16(out, dataType)
    out.write(0)
    out.write(1)
    out.write(body)
    return out.toByteArray()
  }

  private fun record(
    code: Int,
    dataType: Int,
    factory: Long,
    currentValue: Long,
    form: Int = FORM_NONE,
    values: LongArray = longArrayOf(),
  ): ByteArray {
    val out = ByteArrayOutputStream()
    writeU16(out, code)
    writeU16(out, dataType)
    out.write(0) // GetSet
    out.write(1) // IsEnabled: enabled
    writeValue(out, dataType, factory)
    writeValue(out, dataType, currentValue)
    out.write(form)
    if (form == FORM_ENUMERATION) {
      writeU16(out, values.size)
      values.forEach { writeValue(out, dataType, it) }
      writeU16(out, values.size)
      values.forEach { writeValue(out, dataType, it) }
    }
    return out.toByteArray()
  }

  private fun writeValue(out: ByteArrayOutputStream, dataType: Int, value: Long) {
    when (dataType) {
      DATATYPE_UINT8, DATATYPE_INT8 -> out.write((value and 0xFF).toInt())
      DATATYPE_UINT16, DATATYPE_INT16 -> writeU16(out, value.toInt())
      DATATYPE_UINT32, DATATYPE_INT32 -> writeU32(out, value)
      DATATYPE_UINT64, DATATYPE_INT64 -> writeU64(out, value)
      else -> throw IllegalArgumentException("unsupported test datatype 0x%04X".format(dataType))
    }
  }

  private fun writeU16(out: ByteArrayOutputStream, value: Int) {
    out.write(value and 0xFF)
    out.write((value shr 8) and 0xFF)
  }

  private fun writeU32(out: ByteArrayOutputStream, value: Long) {
    for (index in 0 until 4) out.write(((value shr (8 * index)) and 0xFF).toInt())
  }

  private fun writeU64(out: ByteArrayOutputStream, value: Long) {
    for (index in 0 until 8) out.write(((value shr (8 * index)) and 0xFF).toInt())
  }

  private companion object {
    const val DATATYPE_INT8 = 0x0001
    const val DATATYPE_UINT8 = 0x0002
    const val DATATYPE_INT16 = 0x0003
    const val DATATYPE_UINT16 = 0x0004
    const val DATATYPE_INT32 = 0x0005
    const val DATATYPE_UINT32 = 0x0006
    const val DATATYPE_INT64 = 0x0007
    const val DATATYPE_UINT64 = 0x0008
    const val FORM_NONE = 0x00
    const val FORM_ENUMERATION = 0x02
  }
}
