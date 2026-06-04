// Full version config — Electron app with all 23 books but NO embeddings/fastembed/python-runtime.
// 与 Pro 配置（package.json 中 build 段）唯一区别：去掉向量库 + fastembed + python sidecar + runtime。

const path = require("path");

module.exports = {
  appId: "com.canhuili.mingshireader",
  productName: "明史阅读器",
  artifactName: "明史阅读器-${version}-full-${arch}.${ext}",
  asar: true,
  asarUnpack: [
    "backend/**/*",
    "frontend/dist/**/*",
  ],
  files: [
    "electron/**",
    "frontend/dist/**",
    "frontend/public/fonts/**",
    "backend/src/**",
    "!backend/src/data/明代大事年表-完整版.txt",
    "backend/package.json",
    "backend/node_modules/**",
    "package.json",
    "!**/.DS_Store",
    "!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}",
    "!**/node_modules/*/{test,__tests__,tests,powered-test,example,examples,docs,doc}/**",
    "!**/node_modules/*.d.ts",
  ],
  extraResources: [
    {
      from: "backend/.cache",
      to: "backend-data/.cache",
      filter: [
        "library.sqlite",
        "split-*.epub",
      ],
    },
    {
      from: "backend/books",
      to: "backend-data/books",
      filter: ["*.epub"],
    },
  ],
  afterPack: "./electron/build/afterPack.cjs",
  npmRebuild: false,
  directories: {
    buildResources: "electron/build",
    output: "donotpack/release/electron-full",
  },
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.education",
    hardenedRuntime: false,
    gatekeeperAssess: false,
    identity: null,
    icon: "electron/build/icon.icns",
  },
  win: {
    target: [{ target: "zip", arch: ["x64"] }],
    icon: "electron/build/icon.ico",
  },
};
