# 字体目录

本目录打包了 8 款中文字体，UI 设置面板里「正文字体」与「界面字体」两个独立
下拉都可选用。配套 `@font-face` 声明在 [fonts.css](./fonts.css)，由
`frontend/index.html` 的 `<link>` 加载到主文档；EPUB iframe 通过
`frontend/src/App.tsx` 里的 FONT_FACE_CSS 注入。

## 字体清单

| 文件名 | CSS family | 发行方 / 许可 |
|---|---|---|
| 仿宋（匯文仿宋）.ttf | `Huiwen Fangsong` | 匯文系列 · 开源 |
| 漢隸（方正禮器碑）.TTF | `Fangzheng Liqi` | 方正字库 · **个人非商用** |
| 楷體（方正永樂大典）.TTF | `Fangzheng Yongle` | 方正字库 · **个人非商用** |
| 明體（汇文明朝）.ttf | `Huiwen Mingchao` | 匯文系列 · 开源 |
| 瘦金（方正瘦金）.TTF | `Fangzheng Shoujin` | 方正字库 · **个人非商用** |
| 宋體（京華老宋）.ttf | `Jinghua Laosong` | 京华老宋 · 开源 |
| 霞鹜（霞鹜文楷）.ttf | `LXGW WenKai` | 霞鹜文楷 · SIL OFL（开源）· [GitHub](https://github.com/lxgw/LxgwWenKai) |
| 正楷（汇文正楷）.ttf | `Huiwen Zhengkai` | 匯文系列 · 开源 |

## 版权声明

各字体许可不一：

- **绝大多数为开源字体**（霞鹜文楷、匯文 系列、京华老宋 等），可自由使用、
  分发、修改。
- **方正系列**（方正永樂大典楷体、方正瘦金、方正禮器碑） 仅授权**个人非商用**
  使用。如要用于任何商业用途（产品销售、广告、收费内容等），必须自行向方正
  字库取得商业授权，否则违反方正《字库使用许可协议》。

各字体的具体许可、最新版本与商用授权请上网查询其发行方原始声明。本仓库分发
这些字体仅为方便项目本身的个人学习研究使用，不构成任何商用授权或转授权。
