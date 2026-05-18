/**
 * Lite 版打包配置：从 package.json 读 base 配置 → 移除 embedding 相关 extraResources。
 * 用法：electron-builder --mac --config electron-builder.lite.config.cjs
 *
 * Plus 版（默认）走 package.json 的 build 字段。
 */
const path = require("node:path");
const pkg = require("./package.json");

// 浅拷贝再改，不污染 require 缓存里的 pkg
const config = JSON.parse(JSON.stringify(pkg.build));

// extraResources 过滤：去掉 paragraphs-vec-int8.sqlite / sqlite-vec-extensions / embed_query.py
config.extraResources = (config.extraResources || []).map((entry) => {
  if (entry && Array.isArray(entry.filter)) {
    const filter = entry.filter.filter((p) => !p.startsWith("paragraphs-vec-int8"));
    return { ...entry, filter };
  }
  return entry;
}).filter((entry) => {
  if (!entry) return false;
  // 整体扔掉只服务 embedding 的 extraResource
  if (entry.from && /sqlite-vec-extensions|backend\/scripts$|backend\/python-runtime$|backend\/fastembed-cache$/.test(entry.from)) return false;
  if (Array.isArray(entry.filter) && entry.filter.length === 0) return false;
  return true;
});

// 标记成 Lite 版：dmg 文件名带 lite 后缀，避免和 Plus 冲突
config.artifactName = "${productName}-${version}-lite-${arch}.${ext}";

// productName 不改（应用名仍叫 明史阅读器，避免 macOS 本地数据隔离），只改 dmg 文件名
module.exports = config;
