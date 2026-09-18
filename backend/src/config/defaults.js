import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { DEFAULT_CUSTOM_ACTIONS, READER_AGENT_SYSTEM } from "./prompts.js";

dotenv.config();

/**
 * 中文：读取项目目录之外的密钥文件（默认 ~/.keys/minimax.env），就地取用，
 * 不把 key 复制进项目目录。
 *
 * Load an API credential file that deliberately lives outside the repository.
 *
 * `~/.keys/README.md` states the rule this implements: those files "绝不复制到
 * 项目目录". Copying the key into `donotpack/backend.env.keys` would satisfy
 * dotenv but violate that rule, so the backend reads the external file in
 * place instead. Explicit AI_MINIMAX_* environment variables always win, which
 * is how the deployed server supplies the same credential without the file.
 *
 * Args:
 *   filePath (string): absolute path to a `KEY=value` file. A missing or
 *     unreadable file is not an error — it yields an empty object.
 *
 * Returns:
 *   Object<string, string>: parsed entries, or {} when the file is absent.
 */
function readExternalEnvFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    return dotenv.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

const minimaxEnvPath = process.env.MINGSHI_MINIMAX_ENV_FILE
  ? path.resolve(process.env.MINGSHI_MINIMAX_ENV_FILE)
  : path.join(os.homedir(), ".keys", "minimax.env");
const minimaxFile = readExternalEnvFile(minimaxEnvPath);

const MINIMAX_API_KEY = process.env.AI_MINIMAX_API_KEY || minimaxFile.API_KEY || "";
const MINIMAX_BASE_URL = process.env.AI_MINIMAX_BASE_URL || minimaxFile.BASE_URL || "";
const MINIMAX_MODEL = process.env.AI_MINIMAX_MODEL || minimaxFile.MODEL || "";
// 小模型默认与主模型同一个：MiniMax 这个自建端点只挂了一个模型。
// The self-hosted MiniMax endpoint serves a single model, so the "small"
// (cheap, high-frequency) slot points at the same one unless overridden.
const MINIMAX_SMALL_MODEL = process.env.AI_MINIMAX_SMALL_MODEL || MINIMAX_MODEL;

/**
 * 中文：作为小模型使用时应关闭思维链的模型名。主模型位置不受影响。
 *
 * Models whose chain-of-thought should be switched off when they are used in
 * the *small* (cheap, high-frequency) slot.
 *
 * 小模型跑的是检索意图扩展、相关性过滤这类高频短任务，思维链在这里只是纯成本：
 * 既拖慢响应，又把 token 花在用不上的推理上。主模型位置反过来 —— 解读、比对
 * 这类任务正需要它，所以只在小模型位置关。
 *
 * The small slot runs high-frequency, low-value calls (search-intent expansion,
 * relevance filtering) where deliberation is pure cost: it delays the response
 * and spends tokens on reasoning nobody reads. In the main slot the same model
 * benefits from it, so the switch is per-slot rather than per-model.
 *
 * 默认只包含内置 MiniMax 的模型。这个参数是 vLLM/SGLang 的扩展，发给不认识它
 * 的服务商可能直接 400，所以绝不无差别下发。
 *
 * Defaults to the built-in MiniMax models only. `chat_template_kwargs` is a
 * vLLM/SGLang extension and a provider that does not know it may reject the
 * request outright, so it is never sent indiscriminately.
 */
export const NO_THINKING_AS_SMALL = new Set(
  (process.env.AI_NO_THINKING_SMALL_MODELS || [MINIMAX_MODEL, MINIMAX_SMALL_MODEL].filter(Boolean).join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

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

// MiniMax 一旦配置，就排在模型列表最前面并成为默认主/小模型。
// When MiniMax is configured it leads both option lists and becomes the
// default for the main and small slots; the previous DashScope / DeepSeek
// entries stay available so an account can still pick them explicitly.
const withMinimaxFirst = (list) =>
  MINIMAX_MODEL ? [...new Set([MINIMAX_MODEL, ...list])] : list;

// 百炼（DashScope）的模型清单。**顺序即回落链** —— buildModelQueue 依次尝试，
// 所以主模型写具体的日期版在前，通用别名和更早的日期版依次垫后：具体版本可能
// 下线，通用别名总是指向当前可用的那个。
//
// The DashScope model lists. Order is the fallback chain, since buildModelQueue
// walks them in sequence: the pinned dated build leads, with the floating alias
// and older dated builds behind it — a pinned build can be retired, whereas the
// alias always resolves to whatever is current.
const modelOptions = withMinimaxFirst(
  (process.env.AI_MODEL_OPTIONS || "qwen3.7-max-2026-05-20,qwen3.7-max,qwen3.7-max-preview,qwen3.7-max-2026-05-17")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

const smallModelOptions = withMinimaxFirst(
  (process.env.AI_SMALL_MODEL_OPTIONS || "qwen3.7-flash,deepseek-v4-flash-0731")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

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
if (MINIMAX_API_KEY && MINIMAX_BASE_URL && MINIMAX_MODEL) {
  // 排在最前 = 最高优先级（resolveProviderForModel first-match-wins）。
  modelProviders.push({
    id: "default-minimax",
    alias: "MiniMax（自建）",
    presetProvider: "minimax",
    baseURL: MINIMAX_BASE_URL,
    apiKey: MINIMAX_API_KEY,
    models: [...new Set([MINIMAX_MODEL, MINIMAX_SMALL_MODEL])],
  });
}
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
  // 主 baseURL / apiKey 必须成对：配了 MiniMax 就整对切过去，
  // 否则会拿百炼的 key 去打 MiniMax 的地址。
  // baseURL and apiKey are switched as a pair — mixing one provider's endpoint
  // with another's credential is the classic way to produce a 401 that looks
  // like a bad key.
  baseURL: MINIMAX_BASE_URL || baseURL,
  apiKey: MINIMAX_API_KEY || process.env.AI_API_KEY || "",
  // MiniMax 配置存在时压过 AI_DEFAULT_MODEL —— 这是「默认大模型改用 MiniMax」
  // 这条要求的落点，服务器 .env 里的旧默认值不必逐台去删。
  defaultModel: MINIMAX_MODEL || process.env.AI_DEFAULT_MODEL || modelOptions[0] || "deepseek-v4-pro",
  modelOptions,
  smallModel: MINIMAX_SMALL_MODEL || process.env.AI_SMALL_MODEL || smallModelOptions[0] || "deepseek-v4-flash",
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

/**
 * 中文：把一份 AI 设置里所有密钥字段抹掉，只留「是否已配置」的布尔标记。
 *
 * Strip every credential from an AI settings object.
 *
 * The reader only ever needs to know *whether* a key exists (to label the
 * field "已配置" and to decide if AI features are usable), never its value.
 * Returning the value is what made `/api/settings/defaults` hand the server's
 * key to every signed-in account, including visitors.
 *
 * Args:
 *   settings (object|null): an AiSettings-shaped object. Not mutated.
 *
 * Returns:
 *   object: same shape with `apiKey` / `ttsApiKey` / every
 *     `modelProviders[].apiKey` replaced by "", plus the booleans
 *     `apiKeyConfigured`, `ttsApiKeyConfigured`, and a per-provider
 *     `apiKeyConfigured`. `builtin: true` marks providers that come from the
 *     server's own environment so the UI can render them read-only.
 */
export function redactAiCredentials(settings) {
  if (!settings || typeof settings !== "object") return settings;
  return {
    ...settings,
    apiKey: "",
    apiKeyConfigured: Boolean(String(settings.apiKey || "").trim()),
    ttsApiKey: "",
    ttsApiKeyConfigured: Boolean(String(settings.ttsApiKey || "").trim()),
    modelProviders: (settings.modelProviders || []).map((provider) => ({
      ...provider,
      apiKey: "",
      apiKeyConfigured: Boolean(String(provider?.apiKey || "").trim()),
    })),
  };
}

/**
 * 中文：服务端内置凭证，只在进程内使用，绝不出现在任何 HTTP 响应里。
 *
 * The server's own credentials, for in-process use only.
 *
 * Never serialise the return value into a response. It exists so request
 * handlers can attach the built-in key to an outbound LLM call without that
 * key ever passing through the browser.
 *
 * Returns:
 *   object: { apiKey, baseURL, ttsApiKey, ttsBaseURL, modelProviders } —
 *     `modelProviders` entries are tagged `builtin: true`.
 */
export function getBuiltinAiCredentials() {
  return {
    apiKey: DEFAULT_AI_SETTINGS.apiKey,
    baseURL: DEFAULT_AI_SETTINGS.baseURL,
    ttsApiKey: DEFAULT_AI_SETTINGS.ttsApiKey,
    ttsBaseURL: DEFAULT_AI_SETTINGS.ttsBaseURL,
    modelProviders: (DEFAULT_AI_SETTINGS.modelProviders || []).map((p) => ({ ...p, builtin: true })),
  };
}

/**
 * 中文：给前端的默认配置。**已抹掉全部密钥**。
 *
 * Public defaults for the reader, with every credential removed.
 *
 * This endpoint is reachable by any signed-in account, visitors included, so
 * it must never carry a key. The reader gets model lists, prompts and the
 * "configured" booleans; the credentials themselves stay on the server and are
 * attached at request time (see resolveRequestAiSettings in server.js).
 */
export function getPublicDefaults(options = {}) {
  const includeBuiltin = options.includeBuiltin !== false;
  // 脱敏只在启用账号系统时进行。桌面版是本机单用户、用的就是用户自己 .env 里
  // 的 key，抹掉它既无保护对象，又会让「API 配置」面板变成一堆空的只读条目 ——
  // 那是桌面版一直以来可编辑的地方。
  //
  // Redaction applies only where accounts exist. The desktop build is a
  // single-user local app reading the user's own .env; there is nobody to
  // protect the key from, and blanking it would turn the API panel into a list
  // of empty read-only rows — the very place desktop users manage their keys.
  const redact = options.redact !== false;
  if (!redact) {
    return { app: APP_DEFAULTS, ai: { ...DEFAULT_AI_SETTINGS } };
  }
  const ai = redactAiCredentials(DEFAULT_AI_SETTINGS);
  if (!includeBuiltin) {
    // 访客看不到内置条目本身 —— 他们也用不了它（角色门禁在
    // resolveRequestAiSettings），列出来只会让人以为「已经配好了」。
    // Visitors never see the built-in entry: the role gate means they cannot
    // spend it anyway, and listing it would read as "already configured".
    ai.modelProviders = [];
    ai.apiKeyConfigured = false;
    ai.ttsApiKeyConfigured = false;
  } else {
    ai.modelProviders = ai.modelProviders.map((p) => ({ ...p, builtin: true }));
  }
  return { app: APP_DEFAULTS, ai };
}
