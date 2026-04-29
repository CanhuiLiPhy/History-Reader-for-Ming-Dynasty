# 明史阅读器 v0.3

以《明史》为底本、整合 22 部明代史籍的本地交互式阅读 + AI 研读工具。

## 主要功能

- **多书阅读**：明史 + 21 部参考史籍可读，其中 12 部带 EPUB 原典分页阅读，其余按章节段落浏览
- **AI 操作**：选段翻译 / 读音 / 解释 / 问答（多轮，含选段附近原文 + 跨书检索 + 网页搜索综合回答）
- **史料交叉比对**：AI 引导的多书检索 + 相关性过滤 + 原文查看（自动排除当前阅读的本书）
- **古今地名地图**：AI 推断古地名坐标 + 中研院历史地名查询
- **职官检索**：12 官署 + 644 具体官职（含品级、人数、所属、俸禄）+ 3502 历任年表 + 979 藩王 + 55 套字辈命名诗
- **人物编年 / 皇帝世系图（19 帝交互）/ 年号公元换算**
- **阅读体验**：自定义主题（4 套）/ 字体（5 选项 含瘦金体、霞鹜文楷）/ 字号 / 字色
- **批注**：3 色高亮 + 下划线 + 古文圈点（红色字下圆点）+ 笔记 + 书签（编辑、导出 Markdown）
- **辅助**：繁简体切换、AI 朗读（百炼 qwen3-tts 多音色）、左右侧栏可折叠

## 快速开始（开发环境）

### 1. 安装 Node.js

需要 Node.js v18+。从 [nodejs.org](https://nodejs.org/) 下载安装，或用 [nvm](https://github.com/nvm-sh/nvm)。

### 2. 准备字体（可选）

字体不入版本库（商用字库 + 体积）。详见 [frontend/public/fonts/README.md](frontend/public/fonts/README.md)。

```bash
# 下载开源楷体（霞鹜文楷）
cd frontend/public/fonts
curl -sL -o lxgw-wenkai.ttf \
  https://github.com/lxgw/LxgwWenKai/releases/download/v1.501/LXGWWenKai-Regular.ttf
cd ../../..
```

### 3. 准备底本 EPUB

把《明史》EPUB 文件放到 `backend/mingshi.epub`（任意公开渠道获取的明史 EPUB）。

### 4. 安装依赖 & 配置 API Key

```bash
npm --prefix backend install --omit=dev
npm --prefix frontend install
cp backend/.env.example backend/.env
# 编辑 backend/.env 填入 AI_API_KEY（DashScope/火山/DeepSeek/Kimi 任一兼容平台）
```

### 5. 启动

```bash
bash start.sh        # macOS / Linux
# 或
start.bat            # Windows
```

浏览器自动打开 http://127.0.0.1:3100。

## 离线发布版

`start.command`（macOS）/ `start.bat`（Windows）双击即可启动。完整发布包（含 22 部史料数据库、内置 Node.js 运行时、内置字体）请见 [Releases](https://github.com/CanhuiLiPhy/AI4Mingshi/releases)。

## 技术栈

- **前端**：React 19 + TypeScript + Vite + epub.js
- **后端**：Node.js 22 + Express 5 + SQLite (better-sqlite3 + FTS5 trigram)
- **AI**：OpenAI 兼容 API（DashScope / 火山引擎 / DeepSeek / Kimi 等）
- **EPUB 处理**：自动按章节锚点拆分 spine 实现稳定分页
- **字体**：思源宋体 / 仿宋 / 楷书 / 隶书 / 瘦金体（系统优先 + 内置回退）

## 资料库扩展

如需重新导入参考史料：

```bash
# EPUB 源
node backend/scripts/import-epub-source.mjs --slug <slug> --file <path-to-.epub>

# 本地 TXT
node backend/scripts/import-local-text.mjs --slug <slug> --file <path-to-.txt> \
  --chapter-regex '^卷'

# 明实录（多文件按子实录 + 卷二级切分）
node backend/scripts/import-mingshilu.mjs --dir <明实录目录>

# 解析职官扩展数据
node backend/scripts/parse-officials-extended.mjs
```

## 数据声明

古籍文本来自互联网公开资源（Wikisource、CText 等公共数字图书馆及电子书），版权归原始来源所有。AI 辅助功能由第三方大语言模型 API 提供，回答仅供参考。本软件仅供个人学习研究使用，不得用于商业用途。
