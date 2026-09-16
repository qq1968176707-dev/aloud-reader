# 安卓版（APK）

和 iPad 版是同一份网页版代码（`src/web/` + 共用的 `src/renderer/`），外面套一层
Capacitor 壳，把 `dist-web/` 整个打进 APK。所以它**装完就能离线用**，不需要先联网
打开网页。

```bash
npm run build:web        # 先出网页版（base 用默认的 '/'，APK 里页面在 https://localhost/）
npx cap sync android     # 把 dist-web 同步进 android/app/src/main/assets/public
cd android && ./gradlew assembleRelease
```

发版不用手跑这些：`git tag v0.1.1 && git push origin v0.1.1`，
`.github/workflows/release.yml` 里的 `android` 任务会连 APK 一起打好挂到 Release。

---

## 为什么不是 TWA

TWA（Trusted Web Activity）更省事，但它要用手机上的 Chrome 去渲染。国内很多手机
（华为、部分小米/OPPO）根本没有 Chrome，TWA 会退化成带地址栏的浏览器页面，还得联网。
Capacitor 用系统 WebView，把页面打进包里，这两点都不成问题。

## 两个 WebView 的坑（都已处理）

### 1. `speechSynthesis` 在 WebView 里是个空壳

安卓的 WebView 不是 Chrome：`window.speechSynthesis` 存在，但背后没有引擎，
`getVoices()` 返回空、`speak()` 没声音。逐行导读是这个应用的全部意义，所以安卓走
原生 TTS：

- `src/web/nativeSpeech.ts` —— 封装 `@capacitor-community/text-to-speech`，实现
  `HostSpeech` 契约（定义在 `src/shared/types.ts`）
- `src/web/api.ts` 只在 APK 里（`Capacitor.isNativePlatform()`）把它挂到
  `window.aloud.speech`
- `src/renderer/tts/systemEngine.ts` 发现宿主给了引擎就用它，否则还是走 Web Speech API

**词级高亮保住了**：安卓的 `UtteranceProgressListener.onRangeStart`（API 26+）会报出
正在读的字符区间，插件透出为 `onRangeStart` 事件，正好就是卡拉 OK 高亮要的东西。

**暂停没保住**：安卓 TTS 只能 stop，没有 pause。所以暂停 = 停这一行，继续 = 把这一行
**从头再读一遍**。位置不会丢，只是会重读一行——这比一个按了没反应的暂停键诚实。

### 2. Service Worker 不一定注册得上

书里的插图平时由 Service Worker 从 OPFS 里供出来（`/bookasset/…`）。WebView 里
这条路不保证成立。所以加了 `src/web/imageFallback.ts`：**没有 Service Worker 接管
页面时**，用 MutationObserver 盯住 `<img>`/`<image>`，把这些地址换成从 OPFS 读出来的
blob URL。浏览器里有 SW 时它整个不工作，零开销。

这条兜底在 mac 的 Chrome 上实测过（手动停掉 SW，插图照样显示）。

## 签名

`android/app/build.gradle` 的 release 签名从三个环境变量读：

| 变量 | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_PATH` | keystore 文件路径 |
| `ANDROID_KEYSTORE_PASSWORD` | 密码 |
| `ANDROID_KEY_ALIAS` | 别名（`aloud`） |

CI 里对应三个仓库 secret（`ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` /
`ANDROID_KEY_ALIAS`）。**三个变量都没有时会退回 debug 签名**，本机随手打的包照样能
装到自己手机上。

⚠️ **keystore 丢了就换不回来**：同一个 `applicationId` 的 APK，签名密钥变了就装不上
（用户必须先卸载，数据全丢）。密钥文件不在仓库里，备份好。

## 版本号

CI 会按 tag 改 `android/app/build.gradle`：`versionName` 就是版本号，`versionCode`
由 `0.1.2 → 10002` 算出来（必须单调递增，否则装不上新版）。

## 还没验的

APK 本身还没在真机上跑过（这台 mac 上没有 Android SDK 和模拟器，CI 只负责构建）。
拿到手机后重点看四件事：

1. 朗读：点一行有没有声音，词高亮跟不跟得上
2. 插图：章节里的图片显示不显示（SW 或 blob 兜底，两条路任一条通就行）
3. 存储：导入一本大书后杀掉进程再打开，书还在不在（OPFS 在 WebView 里的配额）
4. 手写层：手指/触控笔画线跟不跟手，工具条在手机窄屏上挡不挡字
