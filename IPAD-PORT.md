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

### ~~A. 验证持久化与图片~~ ✅ 2026-09-17 在 mac 上验完

用 `npm run build:web` + `python3 -m http.server 5300`（localhost 算安全上下文）在真
Chrome 里跑通了：

- Service Worker 注册成功并接管页面
- `/bookasset/<id>/images/cover.svg` 由 SW 从 OPFS 供出，200 + 正确 MIME；章节内的
  插图在页面上真的显示出来
- 刷新后书架还在（OPFS 持久化成立），封面、分页、目录跳转、表格都正常
- 点一行开始朗读：行高亮 + 正文变暗 + `speechSynthesis` 真在出声（mac 上是婷婷）

⚠️ **Claude 的浏览器面板（in-app preview）注册不了 Service Worker**——连一行的空 SW 都报
"An unknown error occurred when fetching the script"。这不是本项目的问题，验 SW 必须用
真 Chrome/Safari。

⚠️ 改完 web 代码要**刷两次**才能看到新版本：SW 是 cache-first，第一次刷新只是让新 SW
安装接管，第二次才拿到新 index.html。

### ~~D. 功能缺口~~ ✅ 本次补完（除词典）

- **录音回放**：`recordings.url(bookId, id)` 现在两个宿主都有——桌面返回
  `aloud://recording/…`，浏览器返回 blob URL（面板不再自己拼 URL，并在停止/卸载时
  `revokeObjectURL`）。浏览器实测：录音写进 OPFS、blob URL 能取回。
- **手写层图片**：`aloud://ink-img/` 同样在浏览器里解析不了。新增 `inkImageUrl()`
  helper（对称于 `bookAssetUrl`）+ SW 的 `/inkasset/` 路由（OPFS `ink/<bookId>/<file>`）。
  浏览器实测：写一张 PNG 进 OPFS，`/inkasset/…` 返回 200 + image/png。
- **拖拽导入**：渲染层现在统一把 `File[]` 交给 `books.importFiles`，桌面版在 preload
  里用 `webUtils.getPathForFile` 转回路径。浏览器实测：拖一个 zip 进窗口能导入成功
  （之前是弹出文件选择框）。
- **词典**：web 版仍返回 null（桌面版读的是本地词典文件）。双击查词在 iPad 上不可用。

### B. iPad 朗读与触屏

- ✅ **引擎列表**：web 版只剩「系统语音」，本地模型 / 声音克隆的入口整块不渲染，
  提示文案也换成 iPad 的说法（`ENGINE_OPTIONS` + `IS_WEB`，见 `lib/util.ts`）
- ✅ **iOS 朗读解锁**：`src/web/install.ts` 在第一次 pointerdown/touchend/keydown 里
  speak 一条静音空串再 cancel。原因是引擎真正 speak 之前要 await 语音列表，await
  一结束手势就失效了，iOS 会静默不出声
- ✅ `getVoices()` 首次为空：`systemEngine.ts` 本来就是「监听 + 轮询 + 5s 兜底」
- ⬜ **触屏实测**（需要真 iPad）：翻页手势 vs 长按选字的冲突、工具条尺寸、Apple
  Pencil 压感、掌压拒绝

### C. PWA 外壳收尾

- ✅ `manifest.webmanifest` + 三个图标
- ✅ 「添加到主屏幕」引导：`src/web/A2HSHint.tsx`，只在 iOS Safari 且未安装时、
  进来 2.5 秒后出现一次，点叉记 localStorage 不再出现
- ⬜ **部署**：`dist-web/` 是纯静态目录，放任意 HTTPS 站点即可。等用户定站点
  （Cloudflare Pages 最省事）

### 还没做的

1. 真 iPad 上过一遍（Safari 的 SW/OPFS 配额行为、朗读、Pencil）
2. 部署到 HTTPS
3. 词典

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

## 在 mac 上怎么调 web 版

```bash
npm run build:web
cd dist-web && python3 -m http.server 5300     # localhost 也是安全上下文，SW 能注册
```

然后用**真浏览器**打开 http://127.0.0.1:5300/index.html（不要用 Claude 的浏览器面板，
它禁用了 Service Worker）。想在页面里直接导入书，把 zip 放进 `dist-web/`（注意
`npm run build:web` 会清空这个目录），再在控制台里：

```js
const buf = await (await fetch('/sample-book.zip')).arrayBuffer();
await window.aloud.books.importFiles([new File([buf], 'sample-book.zip')]);
```
