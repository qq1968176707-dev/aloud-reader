# iPad 版移植进度

目标：把逐读做成 iPad 上能装能用的 PWA（Safari →「添加到主屏幕」）。
用户已定：**先做 PWA，不做 Capacitor 原生壳**（零成本、不需要 Xcode 和苹果开发者账号）。

分支：`main`。桌面版行为必须始终不变，每次改完跑 `node scripts/parity.mjs` + `npm run smoke:ui`。

---

## 已完成

### 1. 解析器脱离 Node（commit 3c001d1）

全部解析代码从 `src/main/import/` 移到 `src/shared/import/`，签名由
`(file: string)` 改成 `(data: Uint8Array, name: string)`。主进程只剩「读盘」和
「落盘」两头，浏览器端照用同一套解析。

- `adm-zip` → `fflate`（adm-zip 模块加载期就 require `node:fs`，进不了浏览器）
- `node:path` → `src/shared/import/pathlite.ts`
- pdf.js 由宿主注入 loader（`setPdfjsLoader`）：Electron 要非字面量 specifier 才不被
  esbuild 打包，浏览器要字面量才能被 Vite 打包
- `mobi.ts` 保留 Buffer，显式 `import { Buffer } from 'buffer'`；浏览器侧由
  `vite.web.config.ts` 的别名指向 polyfill。**不要重写这个解码器**，HUFF/CDIC 的
  64 位窗口运算是硬啃下来的
- `archive.ts` 的临时文件整段删除（它只为让内层解析器能读磁盘而存在）

### 2. 浏览器宿主（本次提交）

| 文件 | 作用 |
|---|---|
| `src/web/storage.ts` | OPFS 读写，目录结构刻意和桌面版 userData 一致 |
| `src/web/api.ts` | `window.aloud` 的浏览器实现，对齐 `src/main/preload.ts` 契约 |
| `src/web/install.ts` | **必须第一个 import**，见下方「已知坑」 |
| `src/web/main-web.tsx` | web 入口 |
| `src/web/sw.ts` | Service Worker：离线壳 + 从 OPFS 供书内图片 |
| `src/web/web.css` | 安全区、触控热区、禁橡皮筋滚动 |
| `src/web/defaults.ts` | 桌面默认值 + 平板调整（单页、系统语音、关翻页音） |
| `index-web.html` / `vite.web.config.ts` / `scripts/build-web.mjs` | 构建 |

`src/shared/defaults.ts`：默认值工厂从 `src/main/store.ts` 移出来，两个宿主共用
（否则任一端加设置都会漂移）。

**已实测通过**（Chrome，`npm run dev:web` + 浏览器面板驱动）：

- 应用正常启动，书架 UI 渲染正常
- 导入示例 zip：3 章 / 1081 字，**与桌面版逐字一致**
- 导入真实 MOBI（18MB，GitHub入门与实践）：269 章 / 72482 字，**与桌面版基线逐字
  一致**，耗时 564ms
- 章节读取正常、中文无乱码、`aloud://` 前缀已全部改写成 `/bookasset/`

---

## 接下来要做（按顺序）

### A. 验证持久化与图片（最先做，风险最高）

dev 模式下 `/sw.js` 不存在，所以**书内图片还没验证过**。必须：

1. `npm run build:web` 然后用静态服务器伺服 `dist-web/`（SW 需要真实 origin；
   localhost 算安全上下文，可以直接测）
2. 确认 SW 注册成功，`/bookasset/<bookId>/images/xxx.jpg` 能返回图片
3. 刷新页面确认书架还在（store 是启动时从 OPFS 读的，这条等于验证持久化）
4. 打开书，确认分页、翻页、逐行朗读、手写层都正常

上次卡在这一步：我直接调 API 导入，store 的内存副本没刷新，需要 reload 才能在
UI 里看到书——reload 本身就是持久化验证，接着做就行。

### B. iPad 朗读与触屏（task #3）

- TTS 只留 system 引擎（iOS Safari 的中文语音）。外观/朗读设置面板里本地模型和
  声音克隆的入口要在 web 版隐藏——现在 `api.ts` 里只是让它们返回「不支持」，
  UI 还会显示出来
- ⚠️ iOS 的 `speechSynthesis` 必须由用户手势触发第一次 `speak()`，否则静默失败。
  需要在第一次点朗读时做一次 warm-up
- ⚠️ iOS 的 `getVoices()` 首次返回空，要等 `voiceschanged`
- 触屏：翻页手势与文字选择/长按的冲突，工具条尺寸，手写层 Apple Pencil 压感实测

### C. PWA 外壳收尾（task #4）

- `manifest.webmanifest` 和三个图标已生成（180/192/512）
- 缺：首次访问的「添加到主屏幕」引导（`.a2hs-hint` 样式已写好，组件还没做）
- 缺：部署。`dist-web/` 是纯静态目录，放任意 HTTPS 站点即可
  （Cloudflare Pages 最省事，用户已有账号，见 `project-seo-niche-site` 的经验）

### D. 还没处理的功能缺口

- **录音**：`api.ts` 里的 recordings 已实现（OPFS 存 WAV），但 `RecordingsPanel`
  用 `aloud://recording/...` URL 播放，web 版要改用 `recordings.url()`（已提供，
  返回 blob URL），**这处还没接**
- **词典**：web 版 `dict.lookup` 直接返回 null
- **拖拽导入**：`pathForFile` 在 web 版返回文件名而非路径，Library 的拖拽处理
  需要改成直接用 File 对象调 `books.importFiles`

---

## 已知坑（都是实测踩出来的）

1. **`src/web/install.ts` 必须是 `main-web.tsx` 的第一条 import**。
   `src/renderer/state/store.ts` 在**模块顶层**就调用
   `window.aloud.onImportProgress`，而 ES 模块的 import 先于本体执行——把赋值写在
   入口文件体内来不及，页面白屏且控制台只报
   `Cannot read properties of undefined`。

2. **mobi.ts 不能依赖全局 `Buffer`**。Vite 的别名只映射 import 说明符，不注入
   全局。已改成显式 import，两端都正常。

3. **中文路径 + Electron `loadFile()` 会 ERR_FAILED**。生成 PWA 图标时踩到，
   本项目路径含「第二大脑」。改用 `pathToFileURL().href` + `loadURL()`。

4. **Electron 里 `win.destroy()` 后窗口归零会自动退出应用**，导致图标循环只出
   第一张且退出码仍是 0。已加 `app.on('window-all-closed', () => {})`。
   教训：子进程退出码 0 不等于成功，要校验产物是否真的存在。

5. **TS 5.7 把 `Uint8Array` 变成泛型**（backing buffer 可能是 SharedArrayBuffer），
   撞 DOM 的 `BlobPart` / `FileSystemWriteChunkType`。在 `storage.writeBytes`
   一处收口断言，不要到处改签名。

---

## 自检命令

```bash
npm run typecheck        # 主配置 + Service Worker 配置
npm run build            # 桌面版
npm run build:web        # iPad 版 -> dist-web/
npm run dev:web          # 浏览器调试，开 http://localhost:5200/index-web.html
node scripts/parity.mjs  # 解析回归：本机真实书库重新导入比对章节数/字数
npm run smoke:ui         # 53 个 UI 探针
```

`parity-baseline.json` 不进仓（含书名与本机绝对路径）。新机器先跑
`node scripts/parity.mjs --record` 生成自己的基线。
