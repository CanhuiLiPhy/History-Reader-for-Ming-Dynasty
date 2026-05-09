# 项目架构与功能说明

> 适用版本：v0.4.1（即将进入 v1.0）

## 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ frontend (React 19 + TS + Vite)                             │
│  • 多书阅读 (epub.js / DB-reader)                           │
│  • 选段操作 / AI 调用 / 资料检索 / 设置                     │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ /api/*
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ backend (Node 22 + Express 5)                               │
│  • EPUB 拆分 + DB-reader 段落                               │
│  • SQLite (better-sqlite3 + FTS5 trigram)                   │
│  • 资料检索 + AI proxy + RAG + TTS                          │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ backend/.cache/library.sqlite (590 MB)                      │
│  • 22 本书 / 422k 段 / 43 MB 原文 / 333 MB FTS5 索引        │
└─────────────────────────────────────────────────────────────┘

电子壳：
electron/main.cjs spawn 后端 Node 22 (内置 runtime/) → 加载 BrowserWindow
```

## 前端 (frontend/)

### 入口与布局
- `src/App.tsx` — 主组件（~4000 行），包含全部状态机
- `src/App.css` — 主题 token + 阅读器布局
- `src/index.css` — 全局根样式

### 库文件 (src/lib/)
| 文件 | 职责 |
|---|---|
| `api.ts` | 全部 fetch 调用（通用 timeout 35s，QA 360s，TTS 60s） |
| `markdown.ts` | AI 输出 Markdown → HTML |
| `storage.ts` | localforage 包装的本地持久化 |
| `yearAnnotator.ts` | EPUB iframe 内年号自动注解（CSS tooltip） |
| `reign.ts` | 明代年号 ↔ 公元换算、繁体别名、`resolveSelectionDate` 选段日期解析、农历⇄公历精确转换 |
| `lunar-javascript.d.ts` | `lunar-javascript` 包的最小 TypeScript shim |

### 阅读路径分两条
1. **EPUB 原典路径**（12 部书 + 明史底本）
 - `epub.js` 渲染 iframe
 - 拆分章节由后端做（`epub-splitter.js` 把整本拆成多个 spine section）
 - 高亮 / 下划线 / 圈点用 `epub.js Annotations`，cfi 是标准 EPUB CFI
2. **DB-reader 路径**（10 部检索类书）
 - 后端按 `book_id + chapter_order` 拉一章段落
 - 前端用 CSS 多栏渲染（每列 = 一个 viewport 宽）
 - 翻页区 `.page-turn-zone` 是 `.reader-card` 兄弟节点，不随 host 滚动
 - 锚点段落 reflow：`dbAnchorParaRef` 记当前左上角 paragraph_id，layout 改变时回到同段
 - 高亮自定义 cfi `db:slug:chapter:paragraphId:start-end`，用 DOM TreeWalker 找文本节点 + `range.surroundContents` 包样式 span

### 状态持久化（localStorage 通过 localforage）
| key | 内容 |
|---|---|
| `ai-settings` | baseURL / apiKey / 模型列表 / TTS / 自定义供应商 / 自定义动作 |
| `highlights` | 全部 EPUB + DB-reader 高亮 |
| `notes` / `bookmarks` | 笔记 / 书签 |
| `current-book-slug` | 当前阅读书 |
| `last-location` | EPUB 阅读位置 cfi |
| `reader-theme` / `reader-font-family` / `reader-font-size` / `reader-font-color` | 阅读外观 |
| `reader-layout` / `script-variant` / `page-spread` | 单/双栏 + 简繁正文 |
| `ui-script-variant` | 简繁界面（独立于正文） |
| `date-display` / `show-emperor` | 日期显示模式 + 显示在位皇帝 |
| `auto-annotate` | 是否自动注解年号 |

## 后端 (backend/)

### 入口
- `src/server.js` — Express 5 应用，聚合所有路由

### 核心服务 (src/services/)
| 文件 | 职责 |
|---|---|
| `book-service.js` | 元数据 / 章节 / 全文检索（按 slug 路由到对应书） |
| `epub-splitter.js` | EPUB 按章节锚点拆分 + 缓存 (`backend/.cache/split-*.epub`) |
| `library-reader.js` | DB-reader 章节列表 / 段落分页 |
| `library-db.js` | better-sqlite3 包装 + FTS5 + 资料库导入逻辑 |
| `reference-service.js` | RAG / 史料比对 / QA 链路 / 时间轴 |
| `ai-service.js` | OpenAI 兼容 client + 多供应商凭据路由 + retry |
| `web-search-service.js` | DuckDuckGo HTML 抓取（best-effort，5s 超时） |

### 配置 (src/config/)
- `defaults.js` — 从 `.env` 装载默认 baseURL / apiKey / 模型 / TTS 参数
- `prompts.js` — 全部 AI 提示词（qa / qaPlan / extractKeywords / chronology / pronounce / explain / translate / gloss / crossCompare / etc.）

### 数据 (src/data/)
| 文件 | 内容 |
|---|---|
| `source-manifest.json` | 23 部参考书的 slug / 标题 / 来源 URL / 抓取参数 |
| `source-index.json` | 结构化目录索引（搜索时按 slug 排除当前阅读的本书） |
| `officials.json` | 12 院司 / 644 官职 / 历任 |
| `officials-extended.json` | 3502 历任 + 979 藩王 + 字辈诗（解析自 raw 表 TXT） |
| `emperors.json` | 19 帝时间轴 + 家谱 |
| `geography.json` | 古今地名（局部，用 AI 兜底） |
| `characters.json` | 字辈、谱系数据 |

### 数据库
- `backend/.cache/library.sqlite` (590 MB)
 - `books` (id, slug, title, author, dynasty, source_type, ...)
 - `paragraphs` (id, book_id, chapter, chapter_order, anchor, paragraph_hash UNIQUE, content)
 - `paragraphs_fts` 虚拟表（FTS5 trigram，content + chapter）— 333 MB
 - 索引：`idx_paragraphs_anchor` / `idx_paragraphs_book_chapter_order` / `sqlite_autoindex_paragraphs_1`

### 导入脚本 (backend/scripts/)
| 脚本 | 用途 |
|---|---|
| `import-epub-source.mjs` | 单本 EPUB → SQLite |
| `import-local-text.mjs` | 单本 TXT → SQLite，支持 GB18030 / UTF-8 自动探测 + chapter regex |
| `import-mingshilu.mjs` | 14 部明实录批量导入 |
| `import-sources.mjs` | 从 manifest 中按 slug 抓取 wikisource / ctext |
| `import-targeted-sources.mjs` | 单 slug 定向再抓取 |
| `parse-officials-extended.mjs` | 解析职官扩展表 |

## API 列表

### 阅读 / 元数据
- `GET /api/health`
- `GET /api/settings/defaults`
- `GET /api/library/books` — 22 部书清单
- `GET /api/library/books/:slug/chapters` — DB-reader 章节列表
- `GET /api/library/books/:slug/chapter/:index` — DB-reader 单章
- `GET /api/library/books/:slug/source.epub` — EPUB 原典文件
- `GET /api/book/meta?slug=` — EPUB 元数据 + TOC
- `GET /book/source.epub?slug=` — alias
- `POST /api/book/search` — 全文检索 (混合 / AI 引导)
- `GET /api/book/person-chronology?person=` — 本地人物编年
- `GET /api/book/reign-lookup?term=` — 年号 ↔ 公元换算

### AI
- `POST /api/ai/action` — translate / pronounce / explain / qa / custom
- `POST /api/ai/person-chronology` — AI 整理人物编年（180s timeout）
- `POST /api/ai/speech` — TTS（60s timeout，DashScope qwen3-tts 或 OpenAI 兼容）

### 资料 / RAG
- `POST /api/reference/lookup` — 划词百科
- `POST /api/reference/compare` — 史料交叉比对（300s timeout）
- `POST /api/reference/timeline` — 章节级时间轴
- `GET /api/reference/geography` — 静态古地名集
- `GET /api/reference/geocode?q=` — AI 古地名 → 经纬度（60s timeout）
- `GET /api/reference/chapter-context?slug=&chapter=&highlight=` — 段落上下文（用于源文查看弹窗）
- `GET /api/reference/emperors` — 19 帝
- `GET /api/reference/officials` — 12 院司 + 历任
- `GET /api/reference/reign-convert?term=` — 年号换算
- `GET /api/reference/office-search?q=` — 职官检索

## 搜索 / RAG / QA 流水线

### 全文搜索
1. 客户端选模式：`hybrid` (FTS5 trigram 子串) 或 `ai` (planner 抽词后再 FTS)
2. `searchBook(query, mode, slug)` 返回 章节标题 / 高亮段落 / 跳转锚点

### QA 链路 (`answerReadingQuestion`)
1. **planner** (qaPlan，small 模型，~3s)
 - 输出：`{ needsLibraryLookup, selectionRelevant, needWebSearch, people, events, ..., webQuery }`
 - `needsLibraryLookup === false` → 短路：直接简明回答，不查库不搜网
2. **资料库检索** (`collectReferenceContexts`)
 - AI 引导从 23 部书选定相关 slug
 - 多关键词 FTS 扩展 + 评分排序，最多 10 段
3. **相关性二次过滤** (`filterRelevantReferences`，small 模型)
 - 把候选段交给 AI 评审，剔除与问题无关的（"keep" 数组）
4. **网页搜索** (best-effort)
 - DuckDuckGo HTML 5s 超时，失败返回 []
5. **最终 QA** (large 模型，~30-60s)
 - 综合 选段附近原文 + 过滤后的参考片段 + 网搜 + planner JSON → 简答 + 依据

### 史料交叉比对 (`POST /api/reference/compare`)
- 类似 QA 流，但聚焦在「以选段为锚点跨书寻证」
- 自动排除当前阅读的本书 (`excludeSlug`)

## 日期识别（v0.4 加，v0.4.1 强化）

`frontend/src/lib/reign.ts` + `yearAnnotator.ts`：

### 内联自动注解（仅 EPUB iframe）
- `REIGN_DATE_PATTERN` 匹配 `<reign>?<N>年(<season><leap>?<month>月(<ganzhi>日?)?)?`
- 仅 reign 前缀显式时才下划线，避免噪声
- 命中文：CSS `::after` 即时气泡，不用浏览器原生 title

### 选段「识别日期」工具栏
- `firstDateTokenInSelection`：在选段中找第一个时间锚点（year/month/ganzhi 优先级）
- `lastAnchorBefore` / `lastMonthBefore`：从 contextBefore 回溯最近的 reign+year 与 month
- `findDayByGanzhi`：用 `lunar-javascript` 在 (lunarYear, lunarMonth, isLeap) 中查 ganzhi 对应农历日 → solar day
- 月内找不到 ganzhi 时自动尝试下一月

### 繁简兼容
- `MING_REIGNS[].aliases` 列繁体形式（永樂 / 隆慶 / 萬曆 / 崇禎 / 天啟 / 天順 / 正統）
- `REIGN_CANONICAL` 映射表把任何形式标准化到简体
- 闰/閏 都识别（`LEAP = "(?:闰|閏)"`）

## 多供应商 API（v0.4.1 加）

`AiSettings.modelProviders[]` — 给特定模型绑定独立 (Base URL, API Key)：

```ts
modelProviders: [
  { id, baseURL: "https://ark.../api/v3", apiKey: "ark-...", models: ["doubao-..."] },
]
```

`ai-service.js` 的 `chatCompletion` 按模型路由：
- `resolveProviderForModel(settings, modelName)` 找匹配
- Map 缓存 OpenAI client 一对一对凭据
- 401 不再终止整个 retry chain（一家挂了不影响其他家）

## 主题 / 字体 / UI 简繁

### 主题（4 套）
- `--ui-panel-bg / --ui-text / --ui-page-bg` 等 token 在 `:root[data-reader-theme]` 配置
- 影响所有面板（左/右栏 / 工具栏 / 模态 / 阅读卡片）
- EPUB iframe 也注入主题 CSS（`mingshi-injected-theme` style 元素），覆盖 EPUB 自带 stylesheet
- 默认 / 古籍米黄 / 夜间 / 护眼绿

### 字体
- 内置 `frontend/public/fonts/{lxgw-wenkai,kaiti,shoujin-simplified,shoujin-traditional}.ttf`（~37 MB，gitignored，用户 fetch-fonts 脚本下载）
- 5 选项：宋体（系统）/ 仿宋（系统）/ 楷书（霞鹜文楷·内置）/ 隶书（系统）/ 瘦金体（方正·内置）
- 通过 `--reader-font-family` CSS 变量同时作用于 UI 和 EPUB 内容

### UI 简繁
- `uiScriptVariant`（默认繁体）
- useEffect + OpenCC + MutationObserver 走 `.app-shell` 全部 text 节点 + `<option>` text + `title` / `placeholder` 属性
- 跳过 `<input>/<textarea>` 值（保留用户输入）和阅读区（已有正文转换通道）

## Electron 桌面壳

### 入口 (`electron/main.cjs`)
- 启动 splash 窗口
- spawn backend：用 `runtime/{darwin-arm64,win}/(bin/node|node.exe)` 内置的 Node 22（ABI 127，匹配 better-sqlite3 prebuild）
- 轮询 `/api/health`，ready 后加载 BrowserWindow
- `setWindowOpenHandler`：所有 `window.open` → `shell.openExternal`（系统浏览器打开）
- `app.on("will-quit")`：杀 backend 子进程

### 打包 (electron-builder)
- `package.json` `build` 字段：
 - `asar: true`（unpacked: backend + frontend dist，避免 require-from-asar）
 - `extraResources`: library.sqlite + books/*.epub + mingshi.epub + runtime/{darwin-arm64,win}/
 - `npmRebuild: false`（用预编译 better-sqlite3 v127 prebuild）
 - `afterPack: ./electron/build/afterPack.cjs`（mac ad-hoc codesign）
- 输出：`donotpack/release/electron/`
 - mac：`明史阅读器-X.Y.Z-arm64.dmg`
 - win：`明史阅读器-X.Y.Z-win.zip`（便携版，免安装；`oneClick: true` 的 NSIS 在某些 Win 系统会崩，已弃）

### 跨平台 win 构建
- `donotpack/release/electron/win-build/build-win-from-mac.sh`：
 1. tar 源码（exclude donotpack/CLAUDE.md/.env，硬卡 grep 真实 key）
 2. scp 到远端 Win（Tailscale）— 或 U 盘搬
 3. ssh 跑 `win-build.ps1`：解压 + npm install + 跑 electron-builder + drop-in better-sqlite3 prebuild
 4. scp .exe / .zip 回 mac

### 安全打包
- `.gitignore` 排除：CLAUDE.md / donotpack/ / backend/.env / *.epub / *.sqlite / runtime/ / *.zip / *.dmg
- `build-win-from-mac.sh` exclude 同上 + 打包后 grep 真实 key 模式（命中 `exit 1`）
- electron-builder 用白名单 `files: [...]`，密钥来源文件天然不入 dmg

## 资料库导入流水线

### EPUB 源 (12 部 + 1 底本)
```bash
node backend/scripts/import-epub-source.mjs --slug guoque --file "donotpack/database/国榷 ....epub"
```
- 读 OPF / NCX
- 按章节锚点抽段落（`<p>/<div>/<li>` 块元素）
- 写入 `paragraphs` 表（带 paragraph_hash 去重）

### TXT 源
```bash
node backend/scripts/import-local-text.mjs --slug donglin-liezhuan --file "...txt" --chapter-regex '^东林列传卷' --encoding gb18030
```
- 自动探测 GB18030 / UTF-8
- 按 regex 切章

### Wikisource / ctext
```bash
node backend/scripts/import-sources.mjs --slugs shiku-shu --max-pages 50 --delay-ms 800
```
- 走 `library-db.importReferenceSources`
- 从 manifest 拿 sourceUrl + crawl mode
- 写入 paragraphs（同样的 hash 去重）

## 版本历史

| 版本 | 日期 | 主要变化 |
|---|---|---|
| v0.0 | 2026-04-25 | 初始原型 |
| v0.1 | 2026-04-27 | EPUB 拆分修复 / 23 部资料库初版 / 皇帝世系 / 古今地名 |
| v0.2 | 2026-04-28 | Full / Lite zip 发布版（自带 Node 22 + library.sqlite） |
| v0.3 | 2026-04-29 | 多书阅读 / 字体主题 / 圈点 / 职官全表 / Electron .dmg / win .exe |
| v0.4 | 2026-04-30 | 检索类书目大修 / 锚点 reflow / UI 简繁 / 新图标 |
| v0.4.1 | 2026-04-30 | AI 问答相关性 / 9 预设供应商 / TTS API Key / 中研院新窗口打开 |
