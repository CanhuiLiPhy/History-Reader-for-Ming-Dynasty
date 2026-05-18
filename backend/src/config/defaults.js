import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { DEFAULT_CUSTOM_ACTIONS, READER_AGENT_SYSTEM } from "./prompts.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "../..");
const projectRoot = path.resolve(backendRoot, "..");

// In packaged Electron builds the backend code lives inside the read-only
// app.asar, but writable data (library.sqlite, books/, mingshi.epub) ships in
// extraResources. MINGSHI_DATA_ROOT lets the host point at that writable dir;
// when unset we keep the dev-mode layout under backend/.
const dataRoot = process.env.MINGSHI_DATA_ROOT
  ? path.resolve(process.env.MINGSHI_DATA_ROOT)
  : backendRoot;

const modelOptions = (process.env.AI_MODEL_OPTIONS || "deepseek-v4-pro,glm-4.7,kimi-k2.6,qwen3.6-max-preview")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const smallModelOptions = (process.env.AI_SMALL_MODEL_OPTIONS || "deepseek-v4-flash,qwen3.6-flash,qwen3.6-27b")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

export const PROJECT_ROOT = projectRoot;
export const BACKEND_ROOT = backendRoot;
export const DATA_ROOT = dataRoot;
export const CACHE_ROOT = path.join(dataRoot, ".cache");
export const BOOKS_DIR = path.join(dataRoot, "books");
export const FRONTEND_DIST = process.env.MINGSHI_FRONTEND_DIST
  ? path.resolve(process.env.MINGSHI_FRONTEND_DIST)
  : path.join(projectRoot, "frontend", "dist");
export const BOOK_PATH = process.env.BOOK_PATH
  ? (path.isAbsolute(process.env.BOOK_PATH) ? process.env.BOOK_PATH : path.join(dataRoot, process.env.BOOK_PATH.replace(/^\.\//, "")))
  : path.join(BOOKS_DIR, "ming-shi.epub");
export const PORT = Number.parseInt(process.env.PORT || "3100", 10);

// v1.2.1：默认 API Key 列表（dev 期 env 注入 → 前端首次启动看到；打包版 env 为空 → 列表为空，用户在设置里手动加）。
// 列表顺序 = 调用优先级（ai-service.resolveProviderForModel first-match-wins）。
// 第一条：DeepSeek 官方（只激活 deepseek-v4-pro，作为最优先大模型）。
// 第二条：百炼（其他所有模型，小模型 qwen3.6-flash-2026-04-16 等）。
const baseURL = process.env.AI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const modelProviders = [];
if (process.env.AI_DEEPSEEK_PRO_API_KEY) {
  modelProviders.push({
    id: "default-deepseek",
    alias: "DeepSeek 官方",
    presetProvider: "deepseek",
    baseURL: process.env.AI_DEEPSEEK_PRO_BASE_URL || "https://api.deepseek.com/v1",
    apiKey: process.env.AI_DEEPSEEK_PRO_API_KEY,
    models: ["deepseek-v4-pro"],
  });
}
if (process.env.AI_API_KEY) {
  // 把百炼主 key 也作为一条 provider 放进列表；激活模型 = AI_MODEL_OPTIONS ∪ AI_SMALL_MODEL_OPTIONS 去掉
  // 已被前面 deepseek 官方独占的 deepseek-v4-pro。
  const bailianModels = [...new Set([...modelOptions, ...smallModelOptions])].filter((m) => m !== "deepseek-v4-pro");
  modelProviders.push({
    id: "default-dashscope",
    alias: "百炼 (DashScope)",
    presetProvider: "dashscope",
    baseURL,
    apiKey: process.env.AI_API_KEY,
    models: bailianModels,
  });
}

export const DEFAULT_AI_SETTINGS = {
  baseURL,
  apiKey: process.env.AI_API_KEY || "",
  defaultModel: process.env.AI_DEFAULT_MODEL || modelOptions[0] || "deepseek-v4-pro",
  modelOptions,
  smallModel: process.env.AI_SMALL_MODEL || smallModelOptions[0] || "deepseek-v4-flash",
  smallModelOptions,
  ttsBaseURL: process.env.AI_TTS_BASE_URL || process.env.AI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ttsApiKey: process.env.AI_TTS_API_KEY || process.env.AI_API_KEY || "",
  ttsModel: process.env.AI_TTS_MODEL || "qwen3-tts-flash",
  ttsVoice: process.env.AI_TTS_VOICE || "Cherry",
  systemPrompt: READER_AGENT_SYSTEM.trim(),
  modelProviders,
  customActions: DEFAULT_CUSTOM_ACTIONS
};

export const APP_DEFAULTS = {
  title: "明史 AI 阅读器",
  subtitle: "以《明史》为底本的交互式本地阅读与 AI 研读工具",
  bookPath: BOOK_PATH,
  version: "0.3.0",
  autoAnnotation: true,
  customActions: DEFAULT_CUSTOM_ACTIONS
};

export function getPublicDefaults() {
  return {
    app: APP_DEFAULTS,
    ai: DEFAULT_AI_SETTINGS
  };
}
