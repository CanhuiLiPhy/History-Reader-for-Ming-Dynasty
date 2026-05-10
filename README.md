# 明史阅读器

一个本地的明史阅读工具。包含《明史》等二十多部明代史籍资料，以及时间线、地名，官职等数据库，以及基于大语言模型的辅助阅读系统。

## v1.1 版本更新


**阅读体验**

- 翻页和排版功能优化
- 丰富了内置字体包
- 阅读位置保存功能优化

**笔记 / 时间线**

- 笔记自动与「历史时间线」同步
- 日期识别功能优化
- 历史时间线功能优化

**AI**

- 提供「AI 句读」功能
- 过滤错误引用
- API 配置功能优化

**资料**

- 石匱书数据重制：本紀 1-17 卷 + 后集 1-63 卷的 OCR 粗点校版本入库
- 人物编年新增 776 个历史人物的传记索引

## 功能介绍

**读书**： 适用于 22 部明代主要史籍。

**勾画，笔记和书签**：提供勾画，笔记，书签索引等多样的辅助阅读功能。

**AI 操作**：提供翻译、注音、释义、查百科、跨书史料比对、AI 句读、朗读等辅助阅读功能。

**资料面板**：

- 历史时间线（基于明代大事年表，可按类别和重要性多选筛选）
- 人物编年
- 皇帝世系图
- 历史日期换算
- 职官检索（12 官署、644 具体官职、3500 多条历任年表、979 位藩王）
- 古今地名地图

**外观**：4 套主题（默认米白 / 古籍米黄 / 夜间 / 护眼绿），10 款字体（正文与界面字体可分别设），简繁切换。

## 安装方法

### 方式一：下载安装包（推荐）

到 [Releases](https://github.com/CanhuiLiPhy/Reader-Mingshi/releases) 下载对应平台：

- macOS（Apple Silicon）：`明史阅读器-1.1.0-arm64.dmg`
- Windows x64（解压即用）：`mingshi-reader-1.1.0-win.zip`

装好之后，在「设置」面板中填写大语言模型的 API Key（ OpenAI兼容 ）即可。

### 方式二：源码运行

```bash
git clone https://github.com/CanhuiLiPhy/Reader-Mingshi.git
cd Reader-Mingshi
npm --prefix backend install --omit=dev
npm --prefix frontend install
cp backend/.env.example backend/.env   # 编辑此文件填 AI_API_KEY
bash start.sh                          # macOS / Linux；Windows 用 start.bat
```

字体可自行添加 [frontend/public/fonts/README.md](frontend/public/fonts/README.md)。

详细使用说明见 [docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md)。

## 数据声明

- 古籍正文取自 Wikisource、CText 等公开数字图书馆，和基于PaddleOCR 和 Claude 大模型的扫描本 OCR 整理。版权归原始来源所有。
- 时间线事件库整理自《中国历史大事年表 古代及中世纪史部分》（吉林师范大学历史系编）。
- AI 回答由大模型 API 提供，仅供参考。
- 方正系列三款字体仅授权个人非商业使用。

本工具仅供个人学习研究，**不得用于商业用途**。
