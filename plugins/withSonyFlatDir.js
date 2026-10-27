const fs = require('fs');
const path = require('path');

const { withProjectBuildGradle } = require('expo/config-plugins');

/**
 * expo-sony-camera 依赖 `android/libs/` 下的本地 AAR（Sony PTP/USB 协议实现）。
 *
 * 库模块里自己声明的 flatDir 只对该模块的配置生效：一旦 `:app` 去解析这个 AAR，
 * Gradle 会用它自己的仓库列表，然后报
 *   Could not find :UVCAndroid-sony-bulk-patched:
 * 所以消费方（所有子项目）也必须能看到同一个 flatDir 仓库。
 *
 * 这里把它注入到 prebuild 生成的 android/build.gradle 里，这样每次 prebuild 都会带上。
 */

const MARK = '// @colorlink:sony-flatdir';

function sonyLibsDir() {
  const fallback = path.join(process.cwd(), 'packages', 'sony-camera', 'android', 'libs');
  try {
    const pkg = require.resolve('expo-sony-camera/package.json', { paths: [process.cwd()] });
    // 走 realpath：node_modules 里是软链，真实目录在 packages/sony-camera
    return path.join(fs.realpathSync(path.dirname(pkg)), 'android', 'libs');
  } catch {
    return fallback;
  }
}

module.exports = function withSonyFlatDir(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') return cfg;
    if (cfg.modResults.contents.includes(MARK)) return cfg;

    // Gradle 的 Groovy 字符串里用正斜杠，避免 Windows 路径被当转义
    const dir = sonyLibsDir().replace(/\\/g, '/');

    cfg.modResults.contents = `${cfg.modResults.contents.trimEnd()}

${MARK}
allprojects {
  repositories {
    flatDir {
      dirs new File('${dir}')
    }
  }
}
`;
    return cfg;
  });
};
