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
- ✅ **Apple Pencil / 触控笔能写了**（2026-09-19，用户反馈「笔用不了」后修的三件事）：
  1. **钢笔写出来是透明的**——全平台的 bug，不止 iPad：钢笔（默认笔）是填充而不是描边，
     而 `.ink-layer path { fill: none }` 这条 CSS 规则压过了 SVG 的 `fill` 表现属性。
     颜色现在一律走内联 style（`paintInk()`，`lib/ink.ts`）；内联 style 优先级高于
     样式表，`var()` 在 WebKit 里也可靠。自检的 ink 探针加了 `inkVisible` 断言——
     原来只数路径元素个数，透明的笔画也算数，所以这个 bug 活了这么久
  2. **iOS 抢手势**：`touch-action: none` 挡得住滚动，挡不住 Safari 把笔的按压当成
     长按/选字，几个点之后就发 `pointercancel`。现在在捕获层挂原生的非被动
     `touchstart`/`touchmove` 监听去 `preventDefault()`（React 的 onTouchStart 是被动
     监听，调了没用），外加 `-webkit-touch-callout: none`
  3. **一笔断了整层卡死**：掌压拒绝的「正在画就拒绝新按下」遇到结束事件被系统吞掉的
     笔画，会把之后所有笔画都当手掌拒掉。现在：同一个指针再按下、笔又按下、或旧笔画
     1.5 秒没动静，都视为旧笔画已死；`lostpointercapture` 也会收尾
  - 顺带：接了 `getCoalescedEvents()`——Pencil 是 240Hz 采样，pointermove 每帧只来一次，
    不接的话快速的一笔有四分之三的点被扔掉，弧线会变成折线
- ⬜ **触屏实测**（需要真 iPad）：以上都在 Chrome 里用笔的指针事件复现验证过，
  但 iOS 的手势接管只有真机能验；另外还要看翻页手势 vs 长按选字、工具条尺寸

### ~~C. PWA 外壳收尾~~ ✅

- ✅ `manifest.webmanifest` + 三个图标（图标进仓于 `build/pwa/`，`npm run icon` 生成）
- ✅ 「添加到主屏幕」引导：`src/web/A2HSHint.tsx`，只在 iOS Safari 且未安装时、
  进来 2.5 秒后出现一次，点叉记 localStorage 不再出现
- ✅ **已部署**：<https://qq1968176707-dev.github.io/aloud-reader/>
  推 main 自动发布（`.github/workflows/pages.yml`）。子路径靠 `ALOUD_WEB_BASE`
  贯穿 Vite base / SW 作用域 / `/bookasset/`、`/inkasset/` / manifest。
  换别的站点：`ALOUD_WEB_BASE=/ npm run build:web` 再把 `dist-web/` 丢上去
  （Cloudflare Pages：`npx wrangler pages deploy dist-web`，需要你自己登录）。

### 还没做的

1. **真 iPad 上过一遍**（Safari 的 SW/OPFS 配额行为、朗读解锁、Pencil 压感、
   翻页手势与长按选字的冲突）——地址已经在上面，Safari 打开后「添加到主屏幕」
2. 词典（web 版 `dict.lookup` 返回 null）
3. 站点是公开的：谁拿到链接都能用（书全在本地，不上传，但应用本身能被别人打开）

## 笔记本（新建功能）

一本笔记本就是**一本普通的书**：一个章节，里面 N 个空的叶子块，每块一张纸。所以翻页、
手写、录音、位置记忆、统计全都照旧工作，没有第二套文档模型。

- `src/shared/notebook.ts` 生成，两个宿主共用；`books.create` / `books.addPages`
- 格线用 CSS 画（`.paper-sheet[data-paper]`），行距 = 正文字号 × 行高，调字号时格线跟着变
- 纸张样式另存一份在书架条目 `paper` 字段上，封面就能直接画出纸样，不用为每张卡读 manifest

### 这里有三件事是量出来的，不是想出来的

1. **纸张块外面不能包 div**。`height: 100%` 相对**父元素**解析，包裹层是 auto 高度时
   百分比无从解析 → 实测 6 张纸只排成 1 页、每张 136px。去掉包裹层后 6 张 = 6 页
   （单栏）/ 3 页（双栏对开），纸高 998px 满列。

2. **章节 HTML 缓存必须带 bookId**。原来只用 chapterId 做键，而所有笔记本的章节都叫
   `pages` —— 连开两本笔记本，第二本显示的是第一本的纸。实测：要横线纸，画出来是上一本的
   点阵纸。已改成 `${bookId}|${chapterId}`（普通书籍同样受益，章节 id 只在书内唯一）。

3. **别拿零宽空格当占位符**。U+200B **不是**空白字符，`trim()` 去不掉它，每张纸会带一个
   看不见的"字"让朗读和搜索去处理。纸张块的高度来自 CSS，本来就不需要占位符。

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
npm run smoke:ui         # 全套 UI 探针（十几分钟，朗读是实时采样的）
node scripts/probe.mjs <文件.js> [--book 书名] [--live]   # 单项探针，约 20 秒
```

⚠️ **别在 smoke 套件跑着的时候跑别的 Electron**。`probe.mjs` 原来一上来就
`taskkill /F /IM electron.exe`，把后台的套件一起杀了——表现和"套件卡死"一模一样，我为此
误判了两轮。现在杀进程要显式 `--kill`，并且套件加了看门狗：真卡住会报出最后跑完的探针，
而不是什么都不写。

⚠️ 探针默认跑在**空的临时 profile** 里（`ALOUD_SMOKE_USERDATA`）。探针会改设置、建书，
中途被打断就会留在用户真实的书库里——`spread` 就这么被改过一次。需要真实书库时加 `--live`。

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
await window.__aloudStore.getState().importFiles([new File([buf], 'sample-book.zip')]);
```

⚠️ 要经过 store（`__aloudStore.getState().importFiles`），**不要直接调
`window.aloud.books.importFiles`**：那样书会落盘，但 store 内存里的书单还是旧的，
之后任何一次改书单的操作（打开书、换书架）都会把这份旧书单写回 `library.json`——
书的文件还在，书架上却没了。界面上的导入按钮和拖拽都走 store，不受影响。
