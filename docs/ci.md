# CI / APK 构建说明

## 工作流

| 文件 | 触发 | 作用 |
|---|---|---|
| `.github/workflows/ci.yml` | push / PR | 15 分钟内跑完 typecheck + lint + 单测，给最快反馈 |
| `.github/workflows/android-apk.yml` | push 到 `main` / 手动 `Run workflow` | 完整原生构建，产出 **自包含 release APK** artifact |

## 取 APK

`Actions → Android APK → 最新 Run → 底部 Artifacts → colorlink-apk.zip → 解压得到 app-release.apk`

> Artifact 下载需要登录 GitHub；命令行可以 `gh run download <run-id> -n colorlink-apk`。

## 为什么用 release + debug 签名

`assembleDebug` 出来的 APK **不含 JS bundle**，装到手机上要连 Metro 才能启动；
`assembleRelease` 会把 Hermes bundle 内联进 APK，而 Expo prebuild 生成的
`android/app/build.gradle` 默认给 release 用 `signingConfigs.debug`。

所以产物是：

- ✅ 可以直接 `adb install` / 点开安装，独立运行（不依赖 Metro）；
- ❌ 用 Android 调试证书签名：不能上架、不能做对外分发的覆盖升级。

## 需要正式签名的 release APK

1. 本地生成一个长期 keystore：

   ```bash
   keytool -genkeypair -v -storetype PKCS12 \
     -keystore release.keystore -alias colorlink \
     -keyalg RSA -keysize 2048 -validity 10000
   base64 -w 0 release.keystore > release.keystore.b64   # macOS 用 base64 -i
   ```

2. 在仓库 `Settings → Secrets and variables → Actions` 添加：

   | Secret | 值 |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | `release.keystore.b64` 的内容 |
   | `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
   | `ANDROID_KEY_ALIAS` | `colorlink` |
   | `ANDROID_KEY_PASSWORD` | key 口令 |

3. 在 `android-apk.yml` 里加一个 release job（或在现有 job 里加 step）：

   ```yaml
   - name: Decode keystore
     run: |
       echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > android/app/release.keystore

   - name: Build release APK
     env:
       KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
       KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
       KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
     run: |
       cd android
       ./gradlew assembleRelease --no-daemon \
         -Pandroid.injected.signing.store.file=$PWD/app/release.keystore \
         -Pandroid.injected.signing.store.password=$KEYSTORE_PASSWORD \
         -Pandroid.injected.signing.key.alias=$KEY_ALIAS \
         -Pandroid.injected.signing.key.password=$KEY_PASSWORD
   ```

   产物路径：`android/app/build/outputs/apk/release/app-release.apk`

## 常见失败与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `Warning: Failed to find package 'tools'` + job 挂在 "Setup Android SDK" | `android-actions/setup-android@v3` 内部执行 `sdkmanager tools`，新版 cmdline-tools（16.x）已无该包 | **不要用这个 action**；`ubuntu-latest` 已预装 SDK，直接用 `sdkmanager` |
| `sdkmanager: command not found`（exit 127） | 预装 SDK 的 cmdline-tools 不在 PATH 上 | 把 `$(ls -d "$ANDROID_HOME"/cmdline-tools/*/bin \| head -n1)` 追加到 `$GITHUB_PATH`（工作流已做） |
| `NDK not found` / `ndkVersion` 报错 | RN 模板要求的 NDK 与工作流预装版本不同 | AGP 会按 `ndkVersion` 自动下载；若失败，把 `sdkmanager --install "ndk;<版本>"` 换成 `android/build.gradle` 里的实际版本 |
| `Keystore file not set for signing config release` | 用了 release 但没有签名配置 | 先只打 debug，或按上文加 secrets |
| Gradle OOM / 构建被杀 | Skia + Reanimated 编译吃内存 | 已设置 `-Xmx4g`；必要时拆成 `:app:assembleDebug` 单模块 |
| `npm ci` 报 lock 不一致 | 改了 `package.json` 没更新 lock | 本地 `npm install` 后一起提交 `package-lock.json` |
| 构建超 60 分钟 | 冷缓存 + 低配 runner | 保留 Gradle 缓存（工作流已配），或改用 self-hosted runner |
| 白屏 / 启动瞬间白底闪一下 | `userInterfaceStyle: dark` 需要 `expo-system-ui` | 已加入依赖；改了主题配置记得确认它在 `package.json` 里 |

## 版本速查（本仓库 prebuild 实际产出）

| 项 | 版本 |
|---|---|
| Gradle wrapper | 9.4.1 |
| JDK（CI） | Temurin 17 |
| Node（CI） | 22 |
| NDK 预装 | 27.1.12297006 / 28.0.13004108（AGP 会按需补装） |
| CMake | 3.22.1 |
