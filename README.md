# 明史阅读器 v1.0

以《明史》为底本、整合 22 部明代史籍的本地交互式阅读 + AI 研读工具。

## v1.0 新增（2026-05-04）

> 本次发版的核心是数据质量大修。详见 [docs/0504.md](docs/0504.md)。

- **石匮书数据替换**：从 wikisource 抓取版（218 章 / 4299 段，OCR 噪音多）换为 ctext 净本（卷一~卷四）+ shiku-shu OCR Pass 3 手工重写（卷五~卷十七）的组合版（17 章 / 565 段）。
  - 卷五 ~ 卷十七由 PaddleOCR-VL（Colab A100）+ MinerU 双路 OCR 后，Claude Sonnet 通读重写：删页面分隔符、修跨页接缝、对照 mineru 修订形近错字（千→子、戎→成/去/死、閶→閣 等）。
  - 拼装脚本 [donotpack/database/shiku-shu-ocr/merged/_make_v3.py](donotpack/database/shiku-shu-ocr/merged/_make_v3.py) / [_make_import_txt.py](donotpack/database/shiku-shu-ocr/merged/_make_import_txt.py)。
- **读通鉴论换源 + 预处理**：原 EPUB（Kindle 转出来的"套装 5 册"5.6 MB 版）spine 解析失败导致 reader 区一直空白；换为中华书局 1975 校点本（Calibre 转 843 KB），写一次性预处理脚本 [donotpack/database/preprocess-dutongjianlun.mjs](donotpack/database/preprocess-dutongjianlun.mjs) 把单 spine 段塞多章节（`<p id="fileposNNN">`）的格式拆成 122 个独立 spine 段，让 epub.js 通用逻辑直接 work。
- **保留的小幅通用 bug 修复**：
  - `last-location` localStorage key 改为 per-book（`last-location:${slug}`），避免一本书的 CFI 被另一本书拿来用导致静默 fallback 到封面
  - `rendition.resize()` race fix：guard `manager` 存在 + try/catch 兜底，避免 ResizeObserver 早于 display() 触发时抛 `Cannot read properties of undefined (reading 'resize')`
  - `scrollPendingAnchorIntoView` 改为 iframe-only 滚动（`defaultView.scrollTo`），避免点目录跳转后外层页面也跟着下滑

## v0.4.1（2026-04-30）

- **AI 问答更聪明**：闲聊 / 与明代无关问题不再硬扯检索结果
  - planner 阶段加 `needsLibraryLookup` 判断 — 寒暄、编程、现代时事直接简明回答，不查库不引材料
  - 检索结果加相关性二次过滤 — 拉到的资料经小模型审核，与问题无关的剔除，不引用也不展示
  - 选段无关时不展示选段附近段落作为「依据」
- **API 配置 UX 大改**
  - 新增 9 个**预设供应商下拉**：百炼 / 火山 / DeepSeek / Kimi / Anthropic / Gemini / OpenAI / OpenRouter / MiniMax —— 选完自动填 Base URL + 推荐模型名
  - **新增 TTS API Key 字段**（之前只有 baseURL + 模型，导致 TTS 必须复用主 key）
  - 火山公共模型纠正：v2.0 不存在 → 改为实际可用的 `doubao-1-5-pro-32k-250115` 等
- **古今地名地图：中研院页面修复**
  - 加「**新窗口打开**」按钮 — 嵌入版会被中研院反第三方 cookie 强制跳回首页，新窗口可绕开
  - iframe sandbox 加 `allow-popups-to-escape-sandbox` / `allow-top-navigation-by-user-activation`

## v0.4 改动

- **新图标**：黄底红「明」字（宋体），mac dmg / win exe 同步更新
- **检索类（TXT 来源）书目可读性大改**
  - 翻页区域改为 host 同级元素 — 不再因 scrollLeft > 0 跑出视口（之前第 1 页之后点击边缘失效）
  - 容器锁横滑（`overflow-x: hidden`）— 触摸板 / 滚轮误触不再翻页
  - 翻页稳定器：连点边缘多次后自动 snap 到整数页边界
  - **锚点段落 reflow**：左/右栏开合后 100% 回到原页（先记录视口左上角的段落 ID，layout 变化后用 `data-paragraph-id` 找回它的新列偏移）
  - DB-reader 支持高亮 / 下划线 / 圈点（基于段内字符偏移 cfi）
- **底部进度条**：默认收起，与左侧栏开合同步
- **界面字体简繁切换**：独立于「正文字体转换」，新设置项「界面字体转换」(默认繁体)。OpenCC + MutationObserver 全 UI 即时转换
- **明史 (四庫全書本) 目录清理**：删除前面无用的「其他」章节
- **农历⇄公历精确换算**（v0.3.1 已加）：选段中第一个日期成分（年/月/干支）配合前文上下文计算到日。例：选「秋七月癸酉」自动追溯前文 `<reign>(year)年`，得「永乐元年八月二十八（1403-09-14）」
- **设置可控**：日期显示「仅农历 / 仅公历 / 公历+农历」(默认仅农历)；可选显示在位皇帝 (默认关闭)
- **年号识别**：支持永樂、隆慶、萬曆、崇禎、天啟、天順、正統 等繁体形式 + 闰/閏 兼容
- **多供应商 API**：自定义供应商 (URL + Key + 模型组)，可覆盖默认 key 给特定模型用别家服务；支持「+ 主模型 / + 小模型」分类添加并自动写入主/小模型列表
- **主题铺到全局 UI**：4 套主题 (默认/古籍米黄/夜间/护眼绿) 影响所有面板

## 功能概览

- **多书阅读**：明史 + 21 部参考史籍可读，其中 12 部带 EPUB 原典分页阅读，其余按章节段落浏览
- **AI 操作**：选段翻译 / 读音 / 解释 / 问答（多轮，含选段附近原文 + 跨书检索 + 网页搜索综合回答）
- **史料交叉比对**：AI 引导的多书检索 + 相关性过滤 + 原文查看（自动排除当前阅读的本书）
- **古今地名地图**：AI 推断古地名坐标 + 中研院历史地名查询
- **职官检索**：12 官署 + 644 具体官职 + 3502 历任年表 + 979 藩王 + 55 套字辈命名诗
- **人物编年 / 皇帝世系图（19 帝交互）/ 年号公元换算**
- **阅读体验**：4 套主题 / 5 选项字体（含瘦金体、霞鹜文楷）/ 字号字色自定义
- **批注**：3 色高亮 + 下划线 + 古文圈点（红色字下圆点）+ 笔记 + 书签（编辑、导出 Markdown）
- **辅助**：繁简体切换、AI 朗读（百炼 qwen3-tts 多音色）、左右侧栏可折叠

## 安装方式

### A. 桌面应用（懒人包，推荐）

到 [Releases](https://github.com/CanhuiLiPhy/Reader-Mingshi/releases) 下载对应平台安装包：

| 平台 | 文件 | 大小 |
|------|------|------|
| macOS（Apple Silicon） | `明史阅读器-0.4.1-arm64.dmg` | ~720 MB |
| Windows x64（**便携版**，免安装） | `明史阅读器-0.4.1-win.zip` | ~720 MB |

双击安装后启动。无需另装 Node.js、无需手动导入资料库 — 全部内置。首次进入软件请在右上「设置」面板填入 AI_API_KEY（DashScope / 火山引擎 / DeepSeek / Kimi 等 OpenAI 兼容平台）。

### B. 解压即用 zip 包

到 [Releases](https://github.com/CanhuiLiPhy/Reader-Mingshi/releases) 下载：

| 包 | 内容 | 大小 |
|------|------|------|
| `mingshi-reader-ai-v0.3-full.zip` | 全部 22 部史料 + 内置 Node 22 运行时 + 字体 | 654 MB |
| `mingshi-reader-ai-v0.3-lite.zip` | 仅 5 部核心史料（明史 / 纪事本末 / 国榷 / 北略 / 崇祯长编） | 172 MB |

解压后：
- macOS：双击 `start.command`
- Windows：双击 `start.bat`
- Linux：`bash start.sh`

浏览器自动打开 http://127.0.0.1:3100，在网页设置面板填入 API Key 即可。

### C. 开发模式（源码运行）

```bash
git clone https://github.com/CanhuiLiPhy/Reader-Mingshi.git
cd Reader-Mingshi
npm --prefix backend install --omit=dev
npm --prefix frontend install
cp backend/.env.example backend/.env
# 编辑 backend/.env 填入 AI_API_KEY；BOOK_PATH 默认指向 ./mingshi.epub
bash start.sh                 # macOS / Linux
# 或 start.bat                Windows
```

字体不入版本库（商用字库 + 体积），需要时见 [frontend/public/fonts/README.md](frontend/public/fonts/README.md)。

## 技术栈

- **前端**：React 19 + TypeScript + Vite + epub.js
- **后端**：Node.js 22 + Express 5 + SQLite (better-sqlite3 + FTS5 trigram)
- **桌面壳**：Electron 37 + electron-builder（macOS dmg / Windows NSIS）
- **AI**：OpenAI 兼容 API（DashScope / 火山引擎 / DeepSeek / Kimi 等）
- **EPUB 处理**：自动按章节锚点拆分 spine 实现稳定分页

## 资料库扩展

如需重新导入 / 新增参考史料：

```bash
node backend/scripts/import-epub-source.mjs    --slug <slug> --file <path-to-.epub>
node backend/scripts/import-local-text.mjs     --slug <slug> --file <path-to-.txt> --chapter-regex '^卷'
node backend/scripts/import-mingshilu.mjs      --dir <明实录目录>
node backend/scripts/parse-officials-extended.mjs
```

## 数据声明

### 正文 / 古籍文本

来自互联网公开资源（Wikisource、CText 等公共数字图书馆及电子书）+ 个人整理 +
基于公开资源的 OCR 处理（PaddleOCR-VL / MinerU 双路 OCR + Claude Sonnet
人工通读重写，详见 [docs/0504.md](docs/0504.md)）。版权归原始来源所有。

### 历史时间线数据

历史时间线（资料 → 历史时间线）的事件库来自《**中国历史大事年表 古代及中世
纪史部分**》（吉林师范大学历史系，中国古代及中世纪史教研室 编）的 OCR 扫描
版本。OCR 后做了结构化处理（按年/月/事件级别/事件类别切分）。本项目仅引用，
原始版权归编者所有。

### AI 辅助

由第三方大语言模型 API 提供（DashScope / 火山 / DeepSeek / Anthropic / OpenAI 等），
回答仅供参考。

### 字体版权

`frontend/public/fonts/` 下打包的 8 款中文字体来自不同发行方，许可不一。
**绝大多数为开源字体**（如 霞鹜文楷、汇文 系列、京华老宋 等）；
**方正系列**（方正永乐大典楷体、方正瘦金、方正礼器碑） 仅授权个人非商业使用，
不得用于任何商业用途。各字体的具体许可请上网查询其发行方原始声明。

### 总体

本软件仅供个人学习研究使用，**不得用于商业用途**。如需商业使用，请自行处理
原始数据 / 字体的授权。
