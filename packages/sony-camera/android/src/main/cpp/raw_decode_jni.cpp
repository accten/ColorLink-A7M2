// Sony ARW → ARGB_8888 Bitmap 的 JNI 桥。
//
// 只做一件事：把一张 RAW 解成 8bit sRGB 像素写进 Java 侧传进来的 Bitmap。
// 用 Bitmap 而不是 byte[]，是为了少一次 72MB 的拷贝：24MP 的 RGB888 是 72MB，
// 再往 Java 堆里放一份会把低内存机型直接顶爆。
#include <jni.h>

#include <android/bitmap.h>
#include <android/log.h>

#include <cstdint>
#include <cstring>
#include <string>

#include "libraw/libraw.h"

#define TAG "SonyRawDecode"
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)

namespace {

std::string toStdString(JNIEnv* env, jstring value) {
  if (value == nullptr) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

void throwState(JNIEnv* env, const char* message) {
  jclass clazz = env->FindClass("java/lang/IllegalStateException");
  if (clazz != nullptr) env->ThrowNew(clazz, message);
}

/**
 * 解码参数与桌面端 rawpy 的默认值对齐，这样本机能用 rawpy 出的图做对照：
 * 机身白平衡、sRGB、8bit、AHD 去马赛克、sRGB 伽马、自动提亮阈值 1%。
 *
 * 两个必须照抄 rawpy 的地方（都在本机用 rawpy 逐像素对过）：
 *  - `gamm[0]` 是**幂的倒数**：sRGB 编码要写 1/2.222，写 2.222 会把画面压成线性的暗图
 *    （平均值 14 vs 98，肉眼就是"RAW 打开一片死黑"）。
 *  - `auto_bright_thr = 0.01` 且 `no_auto_bright = 0`，和 rawpy 的自动提亮一致，
 *    否则同样偏暗（73 vs 98）。
 *
 * 部分字段没有 C 接口的 setter（half_size / user_flip / auto_bright_thr），
 * 直接写 params 结构体更省事，语义和 dcraw 命令行一一对应。
 */
void applyParams(libraw_data_t* raw, bool highQuality) {
  libraw_set_output_bps(raw, 8);
  libraw_set_output_color(raw, 1);        // sRGB
  libraw_set_gamma(raw, 0, 1.0f / 2.222f); // 见上面：这是 1/gamma
  libraw_set_gamma(raw, 1, 4.5f);
  libraw_set_no_auto_bright(raw, 0);
  libraw_set_bright(raw, 1.0f);
  libraw_set_demosaic(raw, highQuality ? 3 /* AHD */ : 1 /* VNG，快一半 */);

  raw->params.use_camera_wb = 1;        // 机身白平衡
  raw->params.half_size = 0;            // 全幅
  raw->params.user_flip = -1;           // 按相机里的方向标记
  raw->params.auto_bright_thr = 0.01f;  // 和 rawpy auto_bright_thr 默认一致
  raw->params.output_tiff = 0;
}

/**
 * 输出尺寸。
 *
 * LibRaw 处理完给的是"有效像素"尺寸（A7M2 是 6024×4024），相机自己的 JPEG 是
 * 裁过的 6000×4000（sizes.raw_inset_crops[0] 的 cwidth/cheight）。多出来的
 * 一圈是传感器边缘，按居中裁掉，尺寸才和机身出图对齐。
 */
void outputSize(libraw_data_t* raw, int* width, int* height, int* left, int* top) {
  const int fullWidth = raw->sizes.width;
  const int fullHeight = raw->sizes.height;
  int cropWidth = static_cast<int>(raw->sizes.raw_inset_crops[0].cwidth);
  int cropHeight = static_cast<int>(raw->sizes.raw_inset_crops[0].cheight);
  if (cropWidth <= 0 || cropWidth > fullWidth) cropWidth = fullWidth;
  if (cropHeight <= 0 || cropHeight > fullHeight) cropHeight = fullHeight;

  *width = cropWidth;
  *height = cropHeight;
  *left = (fullWidth - cropWidth) / 2;
  *top = (fullHeight - cropHeight) / 2;
}

}  // namespace

extern "C" JNIEXPORT jintArray JNICALL
Java_expo_modules_sonycamera_RawDecoder_nativeProbe(JNIEnv* env, jobject /*self*/, jstring path) {
  const std::string file = toStdString(env, path);
  libraw_data_t* raw = libraw_init(nullptr);
  if (raw == nullptr) {
    throwState(env, "LibRaw 初始化失败");
    return nullptr;
  }
  int rc = libraw_open_file(raw, file.c_str());
  if (rc != LIBRAW_SUCCESS) {
    std::string message = std::string("打不开 RAW：") + libraw_strerror(rc);
    libraw_close(raw);
    throwState(env, message.c_str());
    return nullptr;
  }
  // 用处理后的输出尺寸（裁掉传感器边缘后），和 Android 侧要创建的 Bitmap 一致
  int width = 0;
  int height = 0;
  int left = 0;
  int top = 0;
  outputSize(raw, &width, &height, &left, &top);
  libraw_close(raw);

  jintArray result = env->NewIntArray(2);
  if (result == nullptr) return nullptr;
  const jint values[2] = {static_cast<jint>(width), static_cast<jint>(height)};
  env->SetIntArrayRegion(result, 0, 2, values);
  return result;
}

extern "C" JNIEXPORT jlong JNICALL
Java_expo_modules_sonycamera_RawDecoder_nativeDecode(JNIEnv* env, jobject /*self*/, jstring path,
                                                     jobject bitmap, jboolean highQuality) {
  const std::string file = toStdString(env, path);
  libraw_data_t* raw = libraw_init(nullptr);
  if (raw == nullptr) {
    throwState(env, "LibRaw 初始化失败");
    return -1;
  }
  applyParams(raw, highQuality != JNI_FALSE);

  int rc = libraw_open_file(raw, file.c_str());
  if (rc != LIBRAW_SUCCESS) {
    std::string message = std::string("打不开 RAW：") + libraw_strerror(rc);
    libraw_close(raw);
    throwState(env, message.c_str());
    return -1;
  }
  rc = libraw_unpack(raw);
  if (rc != LIBRAW_SUCCESS) {
    std::string message = std::string("解包 RAW 失败：") + libraw_strerror(rc);
    libraw_close(raw);
    throwState(env, message.c_str());
    return -1;
  }
  rc = libraw_dcraw_process(raw);
  if (rc != LIBRAW_SUCCESS) {
    std::string message = std::string("处理 RAW 失败：") + libraw_strerror(rc);
    libraw_close(raw);
    throwState(env, message.c_str());
    return -1;
  }

  int err = 0;
  libraw_processed_image_t* image = libraw_dcraw_make_mem_image(raw, &err);
  if (image == nullptr || image->type != LIBRAW_IMAGE_BITMAP) {
    libraw_close(raw);
    throwState(env, "RAW 解码结果不可用");
    return -1;
  }

  AndroidBitmapInfo info;
  void* pixels = nullptr;
  if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS ||
      info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
    libraw_dcraw_clear_mem(image);
    libraw_close(raw);
    throwState(env, "Bitmap 不可写（需要 RGBA_8888）");
    return -1;
  }
  const int targetWidth = static_cast<int>(info.width);
  const int targetHeight = static_cast<int>(info.height);
  // Bitmap 是裁过的 6000×4000，libraw 给的是 6024×4024：只允许"居中裁掉一圈边缘"这一种差异。
  const int fullWidth = static_cast<int>(image->width);
  const int fullHeight = static_cast<int>(image->height);
  const int offsetX = (fullWidth - targetWidth) / 2;
  const int offsetY = (fullHeight - targetHeight) / 2;
  if (offsetX < 0 || offsetY < 0 || targetWidth <= 0 || targetHeight <= 0) {
    libraw_dcraw_clear_mem(image);
    libraw_close(raw);
    throwState(env, "Bitmap 尺寸与解码尺寸不一致");
    return -1;
  }
  if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS ||
      pixels == nullptr) {
    libraw_dcraw_clear_mem(image);
    libraw_close(raw);
    throwState(env, "Bitmap 像素加锁失败");
    return -1;
  }

  const int components = image->colors;
  auto* dst = static_cast<uint8_t*>(pixels);
  const auto* src = reinterpret_cast<const uint8_t*>(image->data);
  for (int y = 0; y < targetHeight; ++y) {
    // Android 的 RGBA_8888 在小端上内存顺序是 B,G,R,A —— 这里按字节写 R,G,B,255。
    uint8_t* row = dst + static_cast<size_t>(y) * info.stride;
    const uint8_t* sample =
        src + (static_cast<size_t>(y + offsetY) * fullWidth + offsetX) * components;
    for (int x = 0; x < targetWidth; ++x) {
      const uint8_t* px = sample + static_cast<size_t>(x) * components;
      uint8_t* out = row + static_cast<size_t>(x) * 4;
      if (components >= 3) {
        out[0] = px[0];
        out[1] = px[1];
        out[2] = px[2];
      } else {
        out[0] = px[0];
        out[1] = px[0];
        out[2] = px[0];
      }
      out[3] = 255;
    }
  }

  AndroidBitmap_unlockPixels(env, bitmap);
  const jlong decodedBytes = static_cast<jlong>(image->data_size);
  libraw_dcraw_clear_mem(image);
  libraw_close(raw);
  LOGW("decoded %dx%d rgb=%d", targetWidth, targetHeight, components);
  return decodedBytes;
}
