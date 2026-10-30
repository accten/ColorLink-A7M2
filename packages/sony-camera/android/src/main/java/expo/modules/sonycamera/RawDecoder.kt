package expo.modules.sonycamera

import android.graphics.Bitmap
import java.io.File
import java.io.FileOutputStream

/**
 * ARW → 可调色图片（PNG 全幅 + 1600px 编辑预览 + 480px 缩略图）。
 *
 * 为什么需要它：ARW 是 TIFF 容器，JS 侧用的 Skia 解不了；不先解出位图，
 * RAW 就只能看内嵌的 1616×1080 小预览。这里用随仓库自带的 LibRaw 解原图，
 * 拿到 6000×4000 的 8bit sRGB 像素（机身白平衡 + AHD 去马赛克），
 * 之后调色/导出走和 JPEG 完全一样的管线。
 *
 * 一张 24MP 的解码 + PNG 编码大约 3~6 秒（平板实测），所以只在用户第一次
 * 打开这张 RAW 时做一次，结果缓存成文件。
 */
object RawDecoder {
  init {
    System.loadLibrary("sonyraw")
  }

  private external fun nativeProbe(path: String): IntArray?

  private external fun nativeDecode(path: String, bitmap: Bitmap, highQuality: Boolean): Long

  /**
   * @param outDir 结果目录（App 私有目录，JS 侧再 move 到最终位置）
   * @param baseName 输出文件名前缀，例如 `sony-camera-1712345`
   */
  fun decode(
    rawPath: String,
    outDir: String,
    baseName: String,
    previewEdge: Int = 1600,
    thumbEdge: Int = 480,
  ): Map<String, Any?> {
    val started = System.currentTimeMillis()
    val input = File(rawPath)
    require(input.isFile) { "RAW 文件不存在：$rawPath" }

    val dims = nativeProbe(rawPath) ?: throw IllegalStateException("读不到 RAW 的尺寸：$rawPath")
    if (dims.size < 2 || dims[0] <= 0 || dims[1] <= 0) {
      throw IllegalStateException("RAW 尺寸异常：${dims.joinToString("x")}")
    }
    val width = dims[0]
    val height = dims[1]
    val decodedAt = System.currentTimeMillis()

    val directory = File(outDir).apply { mkdirs() }
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    try {
      nativeDecode(rawPath, bitmap, true)

      val png = File(directory, "$baseName.png")
      FileOutputStream(png).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }

      val preview = writeScaled(bitmap, previewEdge, File(directory, "$baseName-preview.jpg"), 90)
      val thumb = writeScaled(bitmap, thumbEdge, File(directory, "$baseName-thumb.jpg"), 78)

      return mapOf(
        "pngPath" to png.absolutePath,
        "previewPath" to (preview?.absolutePath ?: png.absolutePath),
        "thumbPath" to (thumb?.absolutePath ?: preview?.absolutePath ?: png.absolutePath),
        "width" to width,
        "height" to height,
        "bytes" to png.length(),
        "decodeMs" to (decodedAt - started),
        "totalMs" to (System.currentTimeMillis() - started),
      )
    } finally {
      bitmap.recycle()
    }
  }

  private fun writeScaled(source: Bitmap, longEdge: Int, target: File, quality: Int): File? {
    val longest = maxOf(source.width, source.height)
    if (longest <= 0) return null
    val scale = longEdge.toFloat() / longest
    val width = maxOf(1, (source.width * scale).toInt())
    val height = maxOf(1, (source.height * scale).toInt())
    val scaled = Bitmap.createScaledBitmap(source, width, height, true)
    return try {
      FileOutputStream(target).use { scaled.compress(Bitmap.CompressFormat.JPEG, quality, it) }
      target
    } catch (error: Throwable) {
      null
    } finally {
      if (scaled !== source) scaled.recycle()
    }
  }
}
