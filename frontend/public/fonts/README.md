# 字体目录

本仓库不直接包含字体文件（商用字库版权 + 体积）。首次运行前请按下表自备字体：

| 选项 | 文件名 | 来源 / 许可 |
|---|---|---|
| 楷书 | `lxgw-wenkai.ttf` | 霞鹜文楷 LXGW WenKai · SIL OFL · [GitHub](https://github.com/lxgw/LxgwWenKai/releases) |
| 楷体（备选） | `kaiti.ttf` | 用户自备（如系统楷体或 FZHanWZKJW） |
| 瘦金体（简） | `shoujin-simplified.ttf` | 方正瘦金书简 · 商业字库 · 用户自备 |
| 瘦金体（繁） | `shoujin-traditional.ttf` | 方正瘦金书繁 · 商业字库 · 用户自备 |

## 一键下载（仅 LXGW Wenkai 开源字体）

```bash
cd frontend/public/fonts
curl -sL -o lxgw-wenkai.ttf \
  https://github.com/lxgw/LxgwWenKai/releases/download/v1.501/LXGWWenKai-Regular.ttf
```

瘦金体需用户自行获取并按上表命名放入此目录。也可以不放——选择"瘦金体"时会回退到系统中文字体（楷书替代）。

## 配套 CSS

`fonts.css` 已经声明了 `@font-face`，把对应 `.ttf` 文件放进来即可生效。
