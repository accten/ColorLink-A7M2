# 为什么把 expo-sony-camera 收进仓库

这里是 `expo-sony-camera@0.2.1` 的本地副本（MIT，上游 <https://github.com/jongan69/expo-sony-camera>）。
根 `package.json` 通过 `"expo-sony-camera": "file:packages/sony-camera"` 引用它，而不是从 npm 安装。

## 只改了一处：本地 AAR 的依赖写法

上游 `android/build.gradle` 用文件路径直接引 AAR：

```gradle
implementation files('libs/UVCAndroid-sony-bulk-patched.aar')
```

AGP 8 在构建库模块（本模块自己产出 AAR）时会直接报错：

```
Direct local .aar file dependencies are not supported when building an AAR.
```

这个错误会让 `assembleRelease` 在配置阶段就失败，整个 APK 构建无法进行。
改成用仓库解析即可绕过（同样是本地文件，但不再被判定为 "直接文件依赖"）：

```gradle
repositories {
    flatDir { dirs "$projectDir/libs" }
}

dependencies {
    implementation(name: 'UVCAndroid-sony-bulk-patched', ext: 'aar')
}
```

另外两处小调整，只为让本地链接依赖在 prebuild/CI 下干净可用：

- `package.json` 的 `exports` 补上 `"./app.plugin.js"`，否则 `expo prebuild` 每次都会警告该 config plugin 无法被 Node 解析；
- 去掉 `devDependencies`、`prepare`、`prepublishOnly`：本地链接依赖不需要它们，`prepare` 反而会在安装时触发模块自带的构建脚本。

## 升级上游时怎么做

1. 重新解包上游版本到 `packages/sony-camera`（排除 `node_modules`）；
2. 重做上面三处改动；
3. `npm install` → `npx tsc --noEmit` → `npx eslint app src tests` → `npx vitest run`；
4. 确认 `npx expo-modules-autolinking resolve --platform android` 里仍有 `expo.modules.sonycamera.SonyCameraModule`。

模块本身提供的 USB/PTP 能力、事件与组件都不受影响，`packages/` 也不参与本项目的类型检查（见根 `tsconfig.json` 的 `exclude`）。
