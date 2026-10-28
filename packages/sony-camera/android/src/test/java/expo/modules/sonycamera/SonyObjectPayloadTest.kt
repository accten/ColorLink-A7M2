package expo.modules.sonycamera

import java.io.ByteArrayOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `GetObject(0x1009)` on the capture handle does not always return a bare JPEG: Sony can prefix
 * the dataset with an offset word, and a body set to RAW answers with a TIFF (ARW) container that
 * contains no `FF D8` at all. Both cases reach the same code path, and getting them wrong is the
 * difference between "the photo transferred" and "the photo silently vanished".
 */
class SonyObjectPayloadTest {
  @Test
  fun returnsBareJpegUnchanged() {
    val jpeg = jpegBytes()

    assertArrayEquals(jpeg, SonyPtpCodec.extractSonyObjectPayload(jpeg))
  }

  @Test
  fun stripsSonyOffsetHeader() {
    val payload = ByteArrayOutputStream()
      .apply {
        write(byteArrayOf(0x10, 0x00, 0x00, 0x00)) // offset to the image, little endian
        write(ByteArray(12)) // whatever the body puts between header and image
        write(jpegBytes())
      }
      .toByteArray()

    assertArrayEquals(jpegBytes(), SonyPtpCodec.extractSonyObjectPayload(payload))
  }

  @Test
  fun keepsRawTiffPayload() {
    // ARW is a TIFF container: "II" 0x2A 0x00. There is no JPEG start marker anywhere.
    val arw = byteArrayOf(0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x02)

    assertArrayEquals(arw, SonyPtpCodec.extractSonyObjectPayload(arw))
  }

  @Test
  fun keepsBigEndianTiffPayload() {
    val arw = byteArrayOf(0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08)

    assertArrayEquals(arw, SonyPtpCodec.extractSonyObjectPayload(arw))
  }

  @Test
  fun keepsPngPayload() {
    val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

    assertArrayEquals(png, SonyPtpCodec.extractSonyObjectPayload(png))
  }

  @Test
  fun returnsUnknownPayloadRatherThanNothing() {
    // Better to hand the bytes on (and let the caller report an unreadable image) than to
    // drop a transfer that actually succeeded.
    val unknown = byteArrayOf(0x01, 0x02, 0x03, 0x04)

    assertEquals(4, SonyPtpCodec.extractSonyObjectPayload(unknown)?.size)
  }

  private fun jpegBytes(): ByteArray =
    byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x01, 0x02, 0x03, 0xFF.toByte(), 0xD9.toByte())
}
