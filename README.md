# 明史阅读器

桌面端的明史阅读工具，把《明史》和二十多部明代史籍放到一处，让查、读、对照都顺手一些。

## 它能做什么

**读书**

- 内置 22 部明代史籍：明史、明实录、明史纪事本末、国榷、明季北略、崇祯长编、罪惟录、三朝辽事实录、大明律、大明会典、国朝献征录、天下郡国利病书、明通鉴、皇明经世文编、廿二史札记、万历野获编、明季南略、东林列传、菽园杂记、石匱书、国朝典汇、读通鉴论
- 12 部按古籍原典分页阅读，10 部按章节段落浏览
- 4 套阅读主题（默认 / 古籍米黄 / 夜间 / 护眼绿），10 款字体可选，简繁切换

**圈点批注**

- 三色高亮、下划线、古文圈点（红色字下小圆点）
- 给选段写笔记，加书签
- 笔记可挂到时间线上，连成自己的研读脉络

**AI 辅助**

- 选段翻译白话、注音、释义、查百科
- 跨二十多本史籍的史料比对
- AI 句读：给古文加标点
- 朗读、人物编年、AI 推断古地名坐标

**研读资料**

- 历史时间线：明代两千多条大事，按事件类别和重要程度筛选浏览，双击任一事件可改可隐藏
- 人物编年：在线整理任一人物的事迹时间线
- 皇帝世系图（19 帝交互式）
- 年号 ↔ 公元日期换算
- 职官检索：12 官署、644 具体官职、3500 多条历任年表、979 位藩王
- 古今地名地图

## 怎么装

### 一、最省事：下载安装包

到 [Releases](https://github.com/CanhuiLiPhy/Reader-Mingshi/releases) 拿对应平台的包：

| 平台 | 文件 |
|------|------|
| macOS（Apple Silicon） | `明史阅读器-1.1.0-arm64.dmg` |
| Windows x64（免安装解压版） | `mingshi-reader-1.1.0-win.zip` |

双击装上，全部古籍和字体内置好了，不用再折腾。第一次进去在右上「设置」面板填一个 AI API Key（百炼、火山、DeepSeek、Kimi、OpenAI 等都支持）就能用。

### 二、源码运行

```bash
git clone https://github.com/CanhuiLiPhy/Reader-Mingshi.git
cd Reader-Mingshi
npm --prefix backend install --omit=dev
npm --prefix frontend install
cp backend/.env.example backend/.env   # 编辑此文件填 AI_API_KEY
bash start.sh                          # macOS / Linux；Windows 用 start.bat
```

字体没放在仓库里（一来体积大，二来部分商用授权），需要的话见 [frontend/public/fonts/README.md](frontend/public/fonts/README.md)。

## 使用说明

详见 [docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md)，里头有截图和分步说明。

## 关于数据

- 古籍正文取自 Wikisource、CText 等公开数字图书馆，加上一些扫描本的 OCR 整理。版权归原始来源所有。
- 时间线事件库整理自《中国历史大事年表 古代及中世纪史部分》（吉林师范大学历史系编）。
- AI 回答由各家大模型 API 提供，仅供参考。
- 内置字体来自不同发行方，许可不一；方正系列三款仅授权个人非商业使用。

本工具仅供个人学习研究使用，**不得用于商业用途**。
