cmake_minimum_required(VERSION 3.18)
project(sonyraw CXX C)

# LibRaw 0.21.4（CDDL-1.0）随仓库自带：见 libraw/COPYRIGHT、libraw/LICENSE.CDDL。
# 只编 ARW/TIFF 需要的部分：JPEG/LCMS/JASPER 关掉，zlib 用 NDK 自带的（DNG 浮点压缩要用）。
set(LIBRAW_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/libraw)

file(GLOB_RECURSE LIBRAW_SOURCES CONFIGURE_DEPENDS ${LIBRAW_ROOT}/src/*.cpp)
# *_ph.cpp 是 LibRaw 给"不编后处理"的精简版准备的占位实现，
# 和真正的实现（mem_image.cpp / file_write.cpp / raw2image.cpp）符号重名，
# 全量编译时必须排除，否则链接期 multiple definition。
list(FILTER LIBRAW_SOURCES EXCLUDE REGEX "_ph\\.cpp$")

add_library(sonyraw SHARED
  raw_decode_jni.cpp
  ${LIBRAW_SOURCES}
)

# LibRaw 源码里既用 "libraw/libraw.h" 又用 "internal/xxx.h"，
# 所以 include 根目录必须是 vendored 目录本身（它同时包含 libraw/ 和 internal/）。
target_include_directories(sonyraw PRIVATE
  ${LIBRAW_ROOT}
  ${LIBRAW_ROOT}/internal
)

target_compile_definitions(sonyraw PRIVATE
  LIBRAW_LIBRARY_BUILD=1
  NO_JPEG=1
  NO_LCMS=1
  NO_JASPER=1
  USE_ZLIB=1
  # 老版本 libraw 里 fseek/fseeko 的名字不一致，NDK 上是 fseeko
  _FILE_OFFSET_BITS=64
)

# -fno-strict-aliasing：dcraw 系代码大量用 union/位运算在 uint16 与 float 之间转换，
# 开严格别名优化在 -O2 下可能把像素算歪（本机用 -O1 对过 rawpy，这里保守起见关掉）。
# -fno-finite-math-only：去马赛克里对 inf/nan 有判断，不能被优化掉。
# -include strings.h：libraw 的元数据代码直接用 strncasecmp / strtok_r，只包含 <string.h>
# 的 libc（比如 bionic 的部分配置）会在编译期报未声明。
target_compile_options(sonyraw PRIVATE -O2 -fno-strict-aliasing -fno-finite-math-only -w
  -include strings.h)
target_link_libraries(sonyraw PRIVATE jnigraphics log z)

set_target_properties(sonyraw PROPERTIES
  CXX_STANDARD 11
  CXX_STANDARD_REQUIRED ON
)
