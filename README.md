# 明史阅读器

一个本地的明史阅读工具。包含《明史》等二十多部明代史籍资料，以及时间线、地名，官职等数据库，以及基于大语言模型的辅助阅读系统。

## v1.3.1 版本更新

**资料**

- 明实录、四库全书本明史、东林列传、菽园杂记 全库导入 jiayan 自动标点版
- 明王室世系树（368 节点）
- 历史计算器：年号·日期·干支换算 + 度量衡 + 时变货币汇率

**修复**

- 搜索结果跳转到错章的问题
- 三朝辽事实录 / 明季北略偶发卡死

## 功能介绍

**读书**： 适用于 22 部明代主要史籍。

**勾画，笔记和书签**：提供勾画，笔记，书签索引等多样的辅助阅读功能。

**AI 操作**：提供翻译、注音、释义、查百科、跨书史料比对、AI 句读、朗读等辅助阅读功能。

**资料面板**：

- 历史时间线（基于明代大事年表，可按类别和重要性多选筛选）
- 人物志
- AI对话
- 历史计算器
- 职官检索（明宗室世系，12 官署、644 官职、3500 多条历任年表、979 位藩王）
- 古今地名地图

**外观**：4 套主题（默认米白 / 古籍米黄 / 夜间 / 护眼绿），10 款字体（正文与界面字体可分别设），简繁切换。

## 安装方法

### 方式一：下载安装包（推荐）

到 [Releases](https://github.com/CanhuiLiPhy/Reader-Mingshi/releases) 下载对应平台：

- macOS（Apple Silicon）：`明史阅读器-1.3.1-arm64.dmg`
- Windows x64（解压即用）：`mingshi-reader-1.3.1-win.zip`

安装包**不附带任何古籍正文数据**，启动后是空库，需自行准备书源后导入（见下「自带书源」一节）。

设置面板里填写大语言模型的 API Key（OpenAI 兼容）即可使用 AI 相关功能。

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

## 自带书源

由于大部分公开来源的明代史籍点校本仍处于版权保护期，本软件不附带任何古籍正文，需要读者自行准备 EPUB / TXT 文件后按照以下方法导入。

### 准备书源文件

软件预定义了 25 部明代史籍的「插槽」，可以自动识别以下规范命名的文件名：

| 推荐写法 | 示例 |
|---------|-----|
| 用 slug 作文件名 | `ming-shi.epub`、`guoque.epub`、`shiku-shu.txt` |
| 用书的中文标题 | `明史.epub`、`国榷.epub`、`明季北略.txt` |
| 包含中文标题的全名也行 | `明史 (张廷玉).epub`、`国榷 谈迁.txt` |

完整的 25 部书 slug 列表：

| slug | 书名 | slug | 书名 |
|------|-----|------|-----|
| `ming-shi` | 明史（底本，必备）| `zuiwei-lu` | 罪惟录 |
| `mingshi-jishi-benmo` | 明史纪事本末 | `guochao-xianzhenlu` | 国朝献征录 |
| `guoque` | 国榷 | `sanchao-liaoshi-shilu` | 三朝辽事实录 |
| `mingji-beilue` | 明季北略 | `tianxia-junguo-libingshu` | 天下郡国利病书 |
| `da-ming-hui-dian` | 大明会典 | `shu-yuan-zaji` | 菽园杂记 |
| `ming-shi-lu` | 明实录 | `ershier-shi-zhaji` | 廿二史札记 |
| `wanli-yehuo-bian` | 万历野获编 | `mingshi-lu-wanli` | 万历起居注 |
| `mingji-nanlue` | 明季南略 | `siku-mingshi` | 明史（四库全书本）|
| `shiku-shu` | 石匮书 | `guochao-dianhui` | 国朝典汇 |
| `donglin-liezhuan` | 东林列传 | `huangming-jingshi-wenbian` | 皇明经世文编 |
| `chongzhen-changbian` | 崇祯长编 | `da-ming-lv` | 大明律 |
| `ming-tong-jian` | 明通鉴 | `shiku-shu-houji` | 石匮书后集 |
| `du-tong-jian-lun` | 读通鉴论 | | |

对于其他书籍，脚本将自动生成 slug，按文件名作书名。

### 推荐数据来源

- [中国哲学书电子化计划 CText](https://ctext.org)
- [维基文库 Wikisource](https://zh.wikisource.org)
- [国学大师网](http://www.guoxuedashi.net)
- 扫描 OCR 本

### 把书源打成压缩包

把准备好的所有 EPUB / TXT 文件**放到同一个文件夹**，整体压缩成 `.zip`（或 `.tar.gz`）：

```bash
# macOS / Linux
cd path/to/your-books-folder
zip -r my-books.zip *.epub *.txt
```

或者在文件管理器里：选中所有文件 → 右键「压缩」。

文件夹里可以混装 EPUB 和 TXT，子目录也能识别（脚本会递归扫描）。

### 运行导入脚本

```bash
node backend/scripts/build-library-from-zip.mjs --zip path/to/my-books.zip
```

脚本会：

1. 解压 zip 到临时目录
2. 扫描所有 `.epub` / `.txt` 文件
3. 按文件名 / EPUB 元数据自动匹配到 25 个预定义 slug
4. EPUB： spine 按章切分；TXT：按标题切分
5. 写入 `backend/.cache/library.sqlite`，已有 slug 会被覆盖
6. 打印导入摘要 + 缺漏 slug 清单

完成后启动软件就能用，**不需要重启后端**。

### 可选参数

- `--clean`：先清空 books 表再导入（慎用，会删掉所有已导入的书）
- `--chapter-regex '^第\d+章'`：自定义 TXT 章节切分规则（默认匹配「卷X / 第X卷 / 第X回 / 第X篇」）

### 补充书籍数据

把新文件单独打个 zip 再跑一次脚本即可，已存在的 slug 会被新文件覆盖，其他书不动。

## 数据声明

- 古籍正文取自 Wikisource、CText 等公开数字图书馆，和基于PaddleOCR 和 Claude 大模型的扫描本 OCR 整理。版权归原始来源所有。
- 时间线事件库整理自《中国历史大事年表 古代及中世纪史部分》（吉林师范大学历史系编）。
- AI 回答由大模型 API 提供，仅供参考。
- 方正系列三款字体仅授权个人非商业使用。

本工具仅供个人学习研究，**不得用于商业用途**。
