# Aloud Reader · 逐读

一个 Windows 桌面电子书阅读器：Apple Books 的功能集与视觉语言，按大屏幕和鼠标 + 键盘重新设计；加上一个 Apple Books 没有的东西——**逐行导读**：一次朗读一行，屏幕上同步点亮那一行（词边界可用时点亮到词），页面跟着声音走，读到跨页边界的那个字就翻页。声音可以是内置神经语音（103 个中文音色，离线），也可以是**你自己的声音**（VoxCPM 零样本克隆）。

全本地。没有账号，没有云，没有遥测。所有数据都是磁盘上可读可改的 JSON。

```bash
npm install
npm run dev          # 开发
npm run dist:win     # 打包：release/ 下出安装版 + 免安装版
```

---

## 1. 功能总览

| 域 | 内容 |
| --- | --- |
| 书架 | 封面网格 / 列表双视图（列表带缩略图与进度）、书架分类（现在阅读 / 想读 / 已读完）、收藏集、搜索、拖拽排序、右键菜单、应用内删除确认 |
| 导入 | EPUB · MOBI/PRC/AZW/AZW3 · PDF · 自定义 `.zip/.aloudbook` 图书包；**按文件头嗅探格式**（`.crswap` 等任意后缀都能进）；书站的 zip 三格式合集包直接导入（自动挑 EPUB）；多文件导入带进度 |
| 阅读 | 四主题（白/褐/灰/夜）× 排版全套（字号/行距/页边距/字距/段距/加粗/两端对齐/六字体）、分页（单/双栏自适应）+ 滚动、卷页动画（鼠标拖拽跟手折页）、翻页音、滚轮翻页（惯性手势=一划一页，Ctrl+滚轮=字号）、阅读时外壳自动隐退 |
| 定位 | 目录 + 标注双面板共存、全文搜索、进度条章节刻度、书内跳转可返回、每本书精确恢复到字符级位置（图片流式加载也不漂移） |
| 标注 | 5 色高亮 + 下划线 + 笔记 + 书签，CSS Custom Highlight API 零重排绘制，导出 Markdown / 纯文本 |
| 逐行导读 | 三引擎（系统 SAPI5 / 内置 Kokoro / 本地模型含声音克隆）、行高亮 + 词级卡拉 OK、页面跟随声音翻页、语速/停顿/自动跟随、克隆声音应用内录制 |
| 阅读录音 | GoodNotes 式边读边录：录音同时记录阅读位置时间线；回放时书页跟随音频跳回当时读到的位置；每本书独立的录音列表（`userData/recordings/`，流式落盘 WAV） |
| 手写标注 | GoodNotes 式全套工具直接写画在书页上：**笔**（圆珠笔/钢笔压感变宽/铅笔砂质）、**荧光笔**、**橡皮**、**形状**（直线/箭头/矩形/椭圆）、**文字框**（点击落字、可再编辑）、**图片**（文件导入或 Ctrl+V 粘贴，可拖动/角柄缩放）、**套索选择**（圈选成组移动/删除）；触控笔压感 + 掌压拒绝（平板可用）；工具条抓住握把可拖到左/右侧变竖排栏（顶部会挡首行），位置记住；一切元素锚定到段落并按段宽归一化——改字号、换分栏、调窗口后重投影跟着段落走，不漂移；Ctrl+Z/Ctrl+Y 撤销重做，按书存于 `userData/ink/` |
| 统计 | 今日目标环、连续天数、四周日历柱状图、各书用时、年度读完列表——全部真实数据 |

## 2. 架构

### 2.1 技术选型与理由

| 层 | 选择 | 为什么 |
| --- | --- | --- |
| 壳 | **Electron 32**（不是 Tauri） | 见下 |
| UI | React 18 + TypeScript 5 | 阅读器的状态机（位置 / 朗读 / 标注）适合组件化；TS 让锚点这类"偏移量"代码可审 |
| 构建 | Vite 5（渲染进程）+ esbuild（主进程 / preload） | 两条独立透明的流水线，没有会随版本漂移的 Electron 插件 |
| 状态 | Zustand | 全局共享状态只有 settings / library / stats 三块，Redux 太重 |
| 打包 | electron-builder → NSIS + portable | 一条命令双产物 |
| 解析 | adm-zip · fast-xml-parser · node-html-parser · marked · pdfjs-dist | 全部在主进程，渲染进程永远拿不到原始文件 |

**为什么是 Electron 而不是 Tauri。** Tauri 包体小 20 倍，正常情况下选它。但本项目的差异化功能整个压在 Web Speech API 上：Tauri 在 Windows 用 WebView2，而 WebView2 的 `speechSynthesis` 不可靠（`getVoices()` 常返回空），拿不到语音更拿不到 `boundary` 事件——逐词高亮直接没了。Electron 的 Chromium 直连 SAPI5 且会为本地语音发 `boundary` 事件，这是离线卡拉 OK 高亮的前提。代价明确接受：安装包 ~90MB，常驻内存 ~200MB。

### 2.2 目录结构

```
阅读器/
├─ design.md                  ★ 锁定的设计系统（改视觉先读它、改它，再改代码）
├─ src/
│  ├─ shared/                 主进程与渲染进程共用（分段/分块规则必须两端一致）
│  │  ├─ types.ts             所有落盘结构的类型
│  │  ├─ text.ts             ★ 叶子块规则、句子切分（朗读段 ≤72 字）、语言判定、搜索
│  │  └─ schemas/*.json       JSON Schema（图书包 / 标注 / 朗读段 / 设置）
│  ├─ main/                   Electron 主进程
│  │  ├─ main.ts              窗口、aloud:// 协议、CSP、原生菜单
│  │  ├─ preload.ts           contextBridge 全部 API（sandbox: true）
│  │  ├─ paths.ts / store.ts  数据目录 + 原子写 JSON（EFS 目录带直写回退）
│  │  ├─ ipc.ts               所有 IPC handler
│  │  ├─ smoke.ts            ★ 自检硬件：18+ 项 UI 回归探针 + 截图
│  │  ├─ import/
│  │  │  ├─ index.ts         ★ 按扩展名 + 文件头嗅探分发；zip 合集包兜底
│  │  │  ├─ html.ts           白名单重建正文 + 提取叶子块（从文档根渲染，防 KF8 丢章）
│  │  │  ├─ epub.ts / pdf.ts / zipbook.ts / archive.ts
│  │  │  └─ mobi.ts          ★ PalmDOC+HUFF/CDIC 解压、pagebreak+filepos 双源分章
│  │  └─ tts/
│  │     ├─ kokoro.ts / voxcpm.ts   应用托管的模型服务（按需拉起、退出杀进程树）
│  │     ├─ local.ts                预设协议（kokoro/voxcpm/openai/gpt-sovits/cosyvoice/自定义）
│  │     └─ voices.ts               克隆音频落 userData（重装不丢）
│  ├─ renderer/
│  │  ├─ components/          Library / Reader / Stats / 面板 / 浮层 / 录音器
│  │  ├─ lib/                 anchors（锚点）· paginator（多栏分页）· pageTurn（卷页）
│  │  ├─ tts/                 controller（朗读状态机）+ 三引擎
│  │  └─ styles/              tokens.css（设计令牌真源）+ app.css
│  └─ …
├─ tts-server/                Python 模型服务（Kokoro 8973 / VoxCPM 8974）+ 安装脚本
├─ scripts/                   dev / build / dist / smoke 运行器
└─ release/                   打包产物（win-unpacked/ 即免安装版）
```

### 2.3 数据流

```
导入:  文件 → (主进程) 嗅探 → 解析 → 白名单HTML + plain.json(叶子块文本)
       → %APPDATA%/Aloud Reader/books/<id>/
阅读:  chapters/*.html → 渲染 → DOM 叶子块模型(与 plain.json 逐块对齐)
       → CSS 多栏分页(translate3d 翻页, Range 永远有效)
标注:  选区 → TextAnchor{chapterId,blockIndex,start,end,exact/prefix/suffix}
       → CSS.highlights 绘制(零重排) → annotations/<id>.json
朗读:  plain 块 → Intl.Segmenter 分句(≤72字) → 引擎合成(先当前句后预取2句)
       → boundary/估算词边界 → 行+词高亮 → 词到哪页翻到哪页
```

### 2.4 锚点模型（为什么扛得住排版变化）

锚点 = `{chapterId, blockIndex, start, end}` + `exact/prefix/suffix` 兜底重锚。`blockIndex` 指向章内**叶子块**（不含块级子元素的块元素）的文档序号，`start/end` 是该块**文本节点原始拼接**（不折叠空白）的字符偏移。规则在 `shared/text.ts`，Node 端（导入时）和浏览器端（渲染后）产出完全一致——这让标注、阅读位置、朗读段在字号/主题/单双栏/窗口大小任意变化下都不失效。

三条不能破的不变量：

1. 叶子块规则和字符偏移必须两端一致（锚点靠它跨进程通用）
2. 高亮一律 CSS Custom Highlight API 画 Range，绝不包 `<span>`（包元素会毁 Range、打断选区、每次朗读触发重排）
3. 字号/主题/分页方式永远不进锚点

## 3. 逐行导读

### 3.1 三引擎

| 引擎 | 音质 | 离线 | 词边界 | 说明 |
| --- | --- | --- | --- | --- |
| 系统（SAPI5） | 机械 | ✓ | ✓ 真实事件 | 零配置兜底；本机通常只有 Huihui/Kangkang/Yaoyao |
| **内置 Kokoro-82M**（默认） | 自然 | ✓ | 按时长估算 | 103 个中文音色，CPU ~7× 实时，应用托管自启自停 |
| 本地模型 | 最好 | 视模型 | 按时长估算 | 预设 VoxCPM（**声音克隆**）/ GPT-SoVITS / CosyVoice / OpenAI 兼容 / 自定义模板 |

Edge 免费接口已死（合成 WebSocket 一律 403，2026-08 实测），界面中已标注。

### 3.2 队列纪律（延迟的真相）

本地模型服务是单 GPU FIFO 队列，所以**排队顺序即延迟**：

- 当前句永远先入队；**预取要等当前句真正出声**（`onStart`）才排队——否则每次跳转都会塞 3 个废任务，几次连点就把想听的句子埋在一分钟的废弃合成后面
- 朗读段上限 72 字（160 字的长句 = 25 秒干等），按逗号/分号切
- 合成期间状态栏如实显示"准备中…"，出声瞬间才切"播放中"
- 人名间隔号「·」送引擎前**等长替换**为空格（TTS 会把它读成"乘"；等长是为了词边界偏移不错位）

### 3.3 声音克隆

应用内录音（ScriptProcessor 直取 PCM，不走 MediaRecorder/decodeAudioData——那条链路对短录音会莫名失败）→ 主进程写 16-bit WAV 存入 `userData/voices/`（重装不丢）→ VoxCPM 参考音频 + 屏幕提示文字原样作参考文本（文字与音频不符是克隆效果差的头号原因）。RTX 5070 Ti 实测 5.3s 音频合成 4.3s。

## 4. 格式与导入

- **按文件头嗅探**：PDF 魔数 / ZIP 局部头 / PalmDB 偏移 60 的 `BOOKMOBI`。浏览器残留的 `.crswap`、`.part` 等任意后缀都能导入
- **zip 分发包**：先试 EPUB，再试自家图书包，最后当"合集包"拆开挑一本（EPUB > AZW3 > MOBI）
- **MOBI 分章双源**：`<mbp:pagebreak>` 为主；当分页符远少于书内目录的 `filepos` 锚点密度时（如《零基础入门学习Python》：6 个分页符 vs 301 个目录锚点），把 filepos 字节偏移并入分章边界——否则整本书糊成几大块
- **KF8 陷阱**：很多 `.azw3` 头里写 mobiType=2 但正文是 KF8 风格（按 `<html>` 切章、`kindle:embed` base32hex 引图）；sanitize 必须从文档根渲染而不是锚在第一个 `<body>`（骨架 shell 会吞掉 85% 正文）
- 分章必须在**原始 Buffer** 上做（filepos 是字节偏移，先解码成 JS 字符串就全错）

## 5. 设计系统

视觉规则的唯一真源是根目录 **`design.md`**（Apple Books grammar：内容为王、材质外壳、单一强调色、弹簧动效）。要点：

- 令牌在 `src/renderer/styles/tokens.css`；strong 色分两档：`--accent` 只用于填充，`--accent-text` 用于文字（WCAG 实测达标值写在 design.md）
- 动效是采样物理弹簧（CSS `linear()`），页面切换走 View Transitions API，`prefers-reduced-motion` 全线塌缩
- 卷页折痕**竖直是决策**（斜折痕做过两次、否掉两次：CSS 刚性镜像必然撕裂或叠影，要做得上 WebGL）
- 阅读 3.5s 无操作后外壳隐退（面板/朗读/选区激活时钉住）
- 12px 字号下限；浮层一律材质+模糊；危险操作走 `--danger` 双档

## 6. 运行 · 打包 · 自检

```bash
npm run dev            # 开发（Vite + esbuild watch）
npm run typecheck
npm run build          # dist/ + dist-electron/
npm run dist:win       # release/：AloudReader-*-setup.exe + portable.exe + win-unpacked/
```

打包缓存已指向 `.eb-cache/`（EFS 加密的用户目录会让 electron-builder 的符号链接缓存炸掉）。

**自检硬件**（先 `npm run build`；结果写 `smoke-result.json`，因为 Windows 下 Electron 的 stdout 不接父 shell）：

```bash
npm run smoke:import                          # 导入流水线（样例书）
node scripts/smoke.mjs import <任意书文件>     # 实书导入体检
npm run smoke:ui                              # 启动真窗口跑 18+ 项回归探针
```

UI 自检覆盖：分页几何（含 125% 缩放分数视口）、卷页不变量（纯镜像/无整页透明）、拖拽翻页、跨章前进/回退落点、阅读位置往返、朗读行序与词高亮、词边界跨页翻页、滚轮手势（惯性串=1页）、面板共存与拖宽、确认对话框链路、页边距无残留。环境变量：`ALOUD_SMOKE_BOOK=书名` 选书，`ALOUD_SMOKE_SHOTS=1` 附四张界面截图，`ALOUD_SMOKE_LOCAL_TTS=<url>` 连本地模型全链路。

⚠️ 跑 UI 自检前先杀掉在跑的实例（单实例锁会让新进程静默退出）；`scripts/smoke.mjs` 已自动处理。

### 快捷键

| 键 | 动作 |
| --- | --- |
| ← → / PgUp PgDn / 空格 | 翻页（朗读时空格=播放/暂停） |
| Home / End | 本章首页 / 末页 |
| 滚轮 · Ctrl+滚轮 | 翻页 · 调字号 |
| Ctrl+F / Ctrl+B | 搜索 / 书签 |
| Ctrl+↑ ↓ | 朗读上一行 / 下一行 |
| F11 / Esc | 全屏 / 逐级退出 |

### 安全边界

- 渲染进程 `sandbox: true` + `contextIsolation`，只经 preload 白名单 API 通信
- 章节 HTML 白名单重建（标签/属性双白名单，链接只留章内跳转与 http(s)）
- 自定义 `aloud://` 协议只服务数据目录内文件，路径穿越在协议层拦截
- CSP 禁外联；书里的远程图片不加载

## 7. 数据目录（`%APPDATA%\Aloud Reader\`）

```
books/<id>/book.json|plain.json|chapters/|images/   导入产物（人类可读）
state/<id>.json                                     阅读位置（锚点+历史）
annotations/<id>.json                               标注
voices/*.wav                                        克隆参考音频
library.json / settings.json / stats.json
```

设置迁移用 `getSettings()` 里的一次性 `migrations` 键，不直接改用户文件（沙箱进程写 %APPDATA% 可能进 MSIX 虚拟化副本）。

### 自定义图书包（`.zip` / `.aloudbook`）

一个 zip，根下放 `book.json`（清单：id/标题/作者/语言/封面/readingOrder/toc）+ 按序的章节文件（HTML 或 Markdown）+ `images/`。完整 Schema 在 `src/shared/schemas/book.schema.json`；`npm run sample` 会生成一本可直接导入的样例书作参照。

## 8. v2 backlog（有意推迟）

1. **AZW3 的 INDX 骨架索引**——现在 KF8 风格靠标记探测已可用，正统 INDX 重组等有可测样本再做
2. **DRM**——不做，永远
3. **朗读跨引擎无缝切换**（播放中换引擎从当前词续播）
4. **WebGL 曲面卷页**（斜折痕的正确实现）
5. **多窗口/分屏对照阅读**
