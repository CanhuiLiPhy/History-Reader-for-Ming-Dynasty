# 项目架构与功能说明

## 总体架构

项目采用“四层结构”：

1. `frontend`：阅读器 UI 与本地状态层
2. `backend`：HTTP API、AI 代理与导入脚本层
3. `backend/.cache/library.sqlite`：底本与参考史料单库
4. `electron`：桌面窗口壳

核心思路是：

- EPUB 阅读体验仍由前端与 `epub.js` 承担
- 全文搜索与参考史料比对改用 SQLite 单库
- LLM 只负责关键词抽取、解释与最终报告生成
- 所有高亮 / 书签 / 笔记继续保存在浏览器本地

## 前端

前端核心文件：

- `frontend/src/App.tsx`
- `frontend/src/App.css`
- `frontend/src/lib/api.ts`
- `frontend/src/lib/markdown.ts`
- `frontend/src/lib/storage.ts`
- `frontend/src/lib/yearAnnotator.ts`

### 前端职责

- 渲染三栏式阅读界面
- 使用 `epub.js` 加载《明史》底本
- 接收用户选段并弹出工具栏
- 发起搜索 / AI / 划词百科 / 史料交叉比对 / 时间轴请求
- 用 `localforage` 实时保存阅读位置、书签、笔记、高亮
- 把 Markdown 格式考证报告渲染成可读卡片
- 提供两京十三省交互式示意图

### 前端本地状态

- `ai-settings`
- `custom-actions`
- `highlights`
- `notes`
- `bookmarks`
- `auto-annotate`
- `last-location`

## 后端

后端核心文件：

- `backend/src/server.js`
- `backend/src/services/book-service.js`
- `backend/src/services/ai-service.js`
- `backend/src/services/library-db.js`
- `backend/src/services/reference-service.js`
- `backend/src/db/schema.sql`
- `backend/src/data/reign-map.js`
- `backend/src/config/prompts.js`

### 后端职责

- 解包 EPUB
- 读取 `container.xml`、`content.opf`、`toc.ncx`
- 提取元数据、目录、章节文本
- 首次启动时把《明史》段落导入 SQLite
- 导入 Wikisource 参考史料 starter corpus
- 提供全文检索、人物编年、年号换算接口
- 提供划词百科、史料交叉比对、时间轴、地理接口
- 通过 OpenAI 兼容 API 代理 AI 功能
- 在模型不稳定时执行自动回退
- 提供 TTS 接口

## SQLite 设计

SQLite 采用单库设计，文件默认位于：

- `backend/.cache/library.sqlite`

当前表结构：

- `books`
  保存书目信息，如《明史》《国榷》《明史纪事本末》《明季北略》《大明会典》《明实录》
- `paragraphs`
  保存段落级文本，包含 `book_id / chapter / anchor / content`
- `paragraphs_fts`
  SQLite FTS5 虚拟表，对 `content` 与 `chapter` 建全文检索索引

触发器保证：

- 插入段落时自动写入 FTS
- 更新段落时同步更新 FTS
- 删除段落时同步删除 FTS 条目

## 辅助资料

固定辅助信息采用 JSON 静态装载：

- `backend/src/data/officials.json`
- `backend/src/data/emperors.json`
- `backend/src/data/geography.json`
- `backend/src/data/characters.json`
- `backend/src/data/source-manifest.json`

这样可以把高频制度资料与低频全文检索分开，避免后端逻辑过重。

## 主要接口

### 书籍与阅读

- `GET /api/book/meta`
- `POST /api/book/search`
- `GET /api/book/person-chronology`
- `GET /api/book/reign-lookup`
- `GET /book/source.epub`

### AI

- `GET /api/settings/defaults`
- `POST /api/ai/action`
- `POST /api/ai/person-chronology`
- `POST /api/ai/speech`

### 参考资料 / RAG

- `GET /api/reference/overview`
- `POST /api/reference/lookup`
- `POST /api/reference/compare`
- `POST /api/reference/timeline`
- `GET /api/reference/geography`

## 搜索策略

搜索采用“两条链路并行”的混合路线：

1. 《明史》正文搜索继续走本地片段检索
2. 模糊问题可先经 `AI 意图检索` 扩展成关键词、人名、事件名、时间提示
3. 划词百科优先匹配本地 JSON 资料，再调用模型做整理
4. 史料交叉比对优先匹配 SQLite 参考史料，再调用模型生成报告

这样可以避免把整本书直接扔给模型，兼顾稳定、成本和速度。

## 轻量级 RAG

交叉比对链路采用“传统检索 + LLM 总结”：

1. 用户选中《明史》一段原文
2. 后端先执行 `extractKeywords` 提示词；若失败则退回本地关键词抽取
3. 用关键词到 `paragraphs_fts` 中检索其他史料段落
4. 将《明史》选段、关键词、参考片段打包给 `crossCompare` 提示词
5. 返回 Markdown 格式考证报告给前端渲染

这条链路不依赖重量级向量库，更适合本地单机与轻量部署。

## 人物编年

人物编年分两层：

1. 本地层：直接检索人名在《明史》中出现的片段，并自动提取年号
2. AI 层：在本地片段基础上进一步整理时间线摘要

## 年号标注

年号标注基于内置的明代年号表：

- 洪武
- 建文
- 永乐
- 洪熙
- 宣德
- 正统
- 景泰
- 天顺
- 成化
- 弘治
- 正德
- 嘉靖
- 隆庆
- 万历
- 泰昌
- 天启
- 崇祯

前端用 DOM 文本节点扫描方式注入标注，不改动原始 EPUB 文件。

## AI 提示词体系

`backend/src/config/prompts.js` 中内置了两层提示词：

1. 全局阅读 Agent
2. 针对具体动作的专项 Prompt

专项 Prompt 包括：

- 翻译
- 读音
- 解释
- 问答
- 人物编年
- 搜索意图扩展
- RAG 关键词提取
- 划词百科
- 史料交叉比对报告

## Electron 层

`electron/main.cjs` 当前负责：

- 创建桌面窗口
- 加载本地 Web 服务
- 拦截外链并改为系统浏览器打开

后续如需正式打包，可在此基础上继续加入：

- 应用图标
- 自动启动本地服务
- 安装包构建流程
- 本地菜单 / 快捷键
