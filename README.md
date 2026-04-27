# 明史阅读器 v0.2

以《明史》为底本的交互式本地阅读与 AI 研读工具。

## 功能

- EPUB 分页阅读、目录跳转、章内翻页
- AI 翻译 / 读音 / 解释 / 问答（支持补充说明）
- 史料交叉比对（AI 引导检索 + 相关性过滤 + 原文查看）
- 古今地名地图（AI 推断坐标 + 中研院历史地名查询）
- 人物编年、皇帝世系图、年号换算、职官检索
- 笔记 / 书签 / 高亮标注（编辑与导出）
- 繁简体切换、AI 朗读（百炼 qwen3-tts）
- 左右侧栏可折叠，阅读区自适应

## 快速开始

### 1. 安装 Node.js

前往 https://nodejs.org/ 下载安装 **v18 或更高版本**。

### 2. 安装依赖

```bash
npm install
npm --prefix backend install
npm --prefix frontend install
```

### 3. 配置

复制 `backend/.env.example` 为 `backend/.env`，填入：

```
BOOK_PATH=/你的明史EPUB文件路径.epub
AI_API_KEY=你的API密钥
```

默认使用阿里云百炼平台（DashScope），支持 deepseek、qwen、kimi、MiniMax 等模型。

### 4. 构建前端

```bash
npm --prefix frontend run build
```

### 5. 启动

**Mac / Linux：**
```bash
bash start.sh
```

**Windows：**
```cmd
start.bat
```

或手动：`cd backend && node src/server.js`，然后打开 http://127.0.0.1:3100

### 6.（可选）导入参考史料

```bash
cd backend
node scripts/import-sources.mjs
# 或从本地 EPUB/TXT 导入
node scripts/import-epub-source.mjs --slug <slug> --file /path/to/book.epub
node scripts/import-local-text.mjs --slug <slug> --file /path/to/book.txt --chapter-regex '^卷'
```

## 参考史料库

支持导入的史料包括：国榷、明通鉴、明实录、明史纪事本末、罪惟录、大明会典、大明律、皇明经世文编、天下郡国利病书、明季北略/南略、东林列传、三朝辽事实录、崇祯长编、石匮书、万历野获编、菽园杂记、廿二史札记、国朝献征录、国朝典汇、明史四库本等。

## 技术栈

- 前端：React + TypeScript + Vite + epub.js
- 后端：Node.js + Express + SQLite (better-sqlite3 + FTS5)
- AI：OpenAI 兼容 API（DashScope / DeepSeek / Kimi 等）

## 数据声明

古籍文本来自互联网公开资源，版权归原始来源所有。AI 功能由第三方 API 提供，仅供参考。本软件仅供个人学习研究。
