package expo.modules.sonycamera

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Sony's property values are not self-describing: the shutter speed packs a fraction into a
 * UINT32, ISO hides a noise-reduction flag in the top byte, and exposure compensation is a
 * signed thousandths value that arrives as an unsigned 16-bit number. These tests pin the
 * encodings down so a monitor never shows a nonsense number.
 */
class SonyExposureTest {
  @Test
  fun formatsFractionalShutterSpeeds() {
    assertEquals("1/250", SonyExposure.shutterSpeed(0x000100FAL))
    assertEquals("1/8000", SonyExposure.shutterSpeed((1L shl 16) or 8000L))
  }

  @Test
  fun formatsFullSecondShutterSpeeds() {
    assertEquals("30s", SonyExposure.shutterSpeed((30L shl 16) or 1L))
    // Sony reports long exposures as 300/10.
    assertEquals("30s", SonyExposure.shutterSpeed((300L shl 16) or 10L))
  }

  @Test
  fun treatsAPlainDenominatorAsOneOver() {
    assertEquals("1/250", SonyExposure.shutterSpeed(250L))
  }

  @Test
  fun rejectsUselessShutterSpeeds() {
    assertNull(SonyExposure.shutterSpeed(0L))
    assertNull(SonyExposure.shutterSpeed(1L shl 16))
  }

  @Test
  fun formatsApertureFromHundredths() {
    assertEquals("f/2.8", SonyExposure.aperture(280L))
    assertEquals("f/4", SonyExposure.aperture(400L))
    assertEquals("f/1.8", SonyExposure.aperture(180L))
    assertNull(SonyExposure.aperture(0L))
  }

  @Test
  fun dropsTheNoiseReductionFlagFromIso() {
    assertEquals("400", SonyExposure.iso(400L))
    // 0x01 in the top byte means multi-frame noise reduction; the value itself is still 400.
    assertEquals("400", SonyExposure.iso((1L shl 24) or 400L))
  }

  @Test
  fun reportsAutoIso() {
    assertEquals("自动", SonyExposure.iso(0xFFFFFFL))
    assertEquals("自动", SonyExposure.iso((2L shl 24) or 0xFFFFFFL))
    assertNull(SonyExposure.iso(0L))
  }

  @Test
  fun formatsExposureCompensationWithASign() {
    assertEquals("0", SonyExposure.exposureCompensation(0L))
    assertEquals("+0.3", SonyExposure.exposureCompensation(333L))
    assertEquals("-0.7", SonyExposure.exposureCompensation(-667L))
    assertEquals("+1", SonyExposure.exposureCompensation(1000L))
  }

  @Test
  fun normalisesSignedCompensationThatArrivedUnsigned() {
    // -0.133 EV as a UINT16 the transport could not tell apart from a positive number.
    assertEquals("-0.1", SonyExposure.exposureCompensation(65403L))
    // -1.0 EV as UINT32.
    assertEquals("-1", SonyExposure.exposureCompensation(4294966296L))
  }

  @Test
  fun mapsWhiteBalanceEnums() {
    assertEquals("自动", SonyExposure.whiteBalance(1L))
    assertEquals("日光", SonyExposure.whiteBalance(2L))
    assertEquals("阴影", SonyExposure.whiteBalance(7L))
    assertNull(SonyExposure.whiteBalance(0x0042L))
  }

  @Test
  fun acceptsOnlyPlausibleBatteryPercentages() {
    assertEquals(87, SonyExposure.batteryPercent(87L))
    assertNull(SonyExposure.batteryPercent(200L))
  }
}
