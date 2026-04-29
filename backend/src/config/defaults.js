import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { DEFAULT_CUSTOM_ACTIONS, READER_AGENT_SYSTEM } from "./prompts.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "../..");
const projectRoot = path.resolve(backendRoot, "..");

const modelOptions = (process.env.AI_MODEL_OPTIONS || "deepseek-v4-pro,kimi-k2.6,qwen3.6-max-preview,MiniMax-M2.5,qwen3.5-plus-2026-04-20")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const smallModelOptions = (process.env.AI_SMALL_MODEL_OPTIONS || "deepseek-v4-flash,qwen3.6-flash,qwen3.6-27b")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

export const PROJECT_ROOT = projectRoot;
export const BACKEND_ROOT = backendRoot;
export const CACHE_ROOT = path.join(backendRoot, ".cache");
export const FRONTEND_DIST = path.join(projectRoot, "frontend", "dist");
export const BOOK_PATH = process.env.BOOK_PATH
  ? (path.isAbsolute(process.env.BOOK_PATH) ? process.env.BOOK_PATH : path.join(backendRoot, process.env.BOOK_PATH.replace(/^\.\//, "")))
  : path.join(backendRoot, "mingshi.epub");
export const PORT = Number.parseInt(process.env.PORT || "3100", 10);

export const DEFAULT_AI_SETTINGS = {
  baseURL: process.env.AI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
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
