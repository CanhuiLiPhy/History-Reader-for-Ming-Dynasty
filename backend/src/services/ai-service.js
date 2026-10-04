import OpenAI from "openai";
import { ACTION_PROMPTS, DEFAULT_CUSTOM_ACTIONS } from "../config/prompts.js";
import { DEFAULT_AI_SETTINGS, NO_THINKING_AS_SMALL } from "../config/defaults.js";

const CHAT_COMPLETION_TIMEOUT_MS = 600000;  // 单模型超时 10 分钟（2026-09-18 放宽一倍，原 5 分钟）

function normalizeBaseUrl(url) {
  return (url || "").replace(/\/+$/, "");
}

function safeJsonParse(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function fillTemplate(template, variables) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? "");
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

/**
 * 中文：剥掉推理模型混在正文里的 <think>…</think> 段。
 *
 * Remove inline chain-of-thought blocks from a completion.
 *
 * Reasoning models such as the self-hosted MiniMax-M2.5 endpoint emit their
 * deliberation inside `<think>…</think>` at the head of `message.content`,
 * with no separate `reasoning_content` field to read instead. Leaving it in
 * breaks two things, not one:
 *
 *   1. Display — the reader would show the model's private monologue.
 *   2. Correctness — several callers JSON.parse this text (search intent
 *      expansion, reference filtering). A `<think>` prefix makes every one of
 *      those parses throw, silently degrading those features to their
 *      fallbacks.
 *
 * A `<think>` with no closing tag means the response hit the token ceiling
 * while still reasoning, so no answer was produced: that yields "" rather than
 * a truncated fragment of the model's thinking.
 *
 * Args:
 *   text (string): raw `message.content` from the completion.
 *
 * Returns:
 *   string: the answer with reasoning blocks removed, trimmed. "" when the
 *     response contained only unterminated reasoning.
 */
function stripReasoningBlocks(text) {
  if (!text) return "";
  let out = String(text).replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (/<think>/i.test(out)) return "";
  return out.trim();
}

/** MiniMax-M2.5 原生提示词的分段标记。/ Segment markers of the raw M2.5 prompt. */
const MINIMAX_BOS = "]~!b[";
const MINIMAX_TURN_END = "[e~[";
const MINIMAX_TURN_START = "]~b]";
/** 生成到下一个轮次标记就停。/ Stop as soon as the next turn marker appears. */
const MINIMAX_STOP = [MINIMAX_TURN_END, MINIMAX_TURN_START];

/**
 * 中文：手工渲染 MiniMax-M2.5 的原生提示词，并把思考块预先闭合。
 *
 * Render MiniMax-M2.5's native prompt with the reasoning block pre-closed.
 *
 * 为什么不能用采样参数关思维链：M2.5 的 chat template 在每个 generation prompt
 * 末尾**硬编码**了 `<think>\n`。模型还没开始生成，思考的起始标记就已经在
 * prompt 里了 —— 这不是任何请求参数能撤销的。实测无效的写法：
 * enable_thinking / thinking.type=disabled / reasoning_effort=none /
 * chat_template_kwargs / /no_think / assistant 前缀填充，共八种。
 *
 * 所以绕开 /v1/chat/completions，改用 /v1/completions 裸接口自己拼模板，末尾给
 * 一个**空的、已闭合的** `<think></think>`：模型看到思考已经结束，直接写正文。
 *
 * Why no sampling parameter can do this: the model's chat template hardcodes
 * `<think>\n` at the end of every generation prompt, so the opening marker is
 * already in the context before the model emits a single token. Eight documented
 * spellings were measured against the live endpoint and every one still produced
 * a reasoning block. Bypassing the chat endpoint and closing the block in the
 * prompt itself is what actually works.
 *
 * 模板取自服务端 /tokenize 的反推结果，不是猜的。stripReasoningBlocks 仍作兜底。
 * The markers were recovered from the server's own /tokenize output rather than
 * guessed; stripReasoningBlocks still runs afterwards as a backstop.
 *
 * 实测收益（同一问题）：130 tokens / 2.38 s → 52 tokens / 1.68 s。
 * Measured on one identical prompt: 130 tokens / 2.38 s → 52 tokens / 1.68 s.
 *
 * Args:
 *   messages (Array<{role: string, content: string}>): the conversation, in the
 *     same shape the chat endpoint takes. `assistant` maps to the model's own
 *     `ai` role name; anything not `system` is treated as `user`.
 *
 * Returns:
 *   string: a complete prompt ending in an empty, closed reasoning block.
 */
function renderMinimaxPrompt(messages) {
  let prompt = MINIMAX_BOS;
  for (const message of messages || []) {
    const role = message.role === "assistant" ? "ai" : message.role === "system" ? "system" : "user";
    prompt += `${MINIMAX_TURN_START}${role}\n${message.content ?? ""}${MINIMAX_TURN_END}\n`;
  }
  // 关键的一行：空的已闭合 think 块。/ The load-bearing line: an empty closed block.
  return `${prompt}${MINIMAX_TURN_START}ai\n<think>\n\n</think>\n\n`;
}

/**
 * 中文：把可能混进错误信息里的密钥抹掉，再往外抛。
 *
 * Redact anything key-shaped from an upstream error message.
 *
 * The global error handler returns `error.message` to the browser. Managed
 * providers redact credentials in their own error bodies, but this deployment
 * also talks to a self-hosted OpenAI-compatible endpoint whose error format is
 * not under our control, so the value is scrubbed here rather than trusted.
 *
 * Args:
 *   message (string): raw error text.
 *
 * Returns:
 *   string: same text with long key-like tokens replaced by "[已隐去]".
 */
export function scrubSecrets(message) {
  if (!message) return "";
  return String(message)
    // sk-…, ark-…, Bearer …, and bare 24+ char credential-looking tokens.
    .replace(/\b(?:sk|ark|key)-[A-Za-z0-9_-]{8,}/gi, "[已隐去]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [已隐去]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[已隐去]");
}

/**
 * 中文：把客户端传来的设置和服务端默认值合并。
 *
 * Merge caller-supplied AI settings over the server's defaults.
 *
 * Args:
 *   overrides (object): caller-supplied settings; any absent field falls back
 *     to the server default.
 *   options (object): `allowServerDefaults` (boolean, default true) — when
 *     false, **credential** fields (apiKey / ttsApiKey / modelProviders) no
 *     longer fall back to the environment; only what the caller passed is used.
 *     Non-credential defaults (model lists, prompts, voice) still apply.
 *
 *     The web deployment passes false. Without it the `overrides.apiKey ||
 *     DEFAULT_AI_SETTINGS.apiKey` fallback below would silently hand the
 *     server's built-in key to *every* caller, defeating the role gate that is
 *     supposed to keep it away from visitor accounts.
 *
 * Returns:
 *   object: the effective settings for one request.
 */
export function resolveAiSettings(overrides = {}, options = {}) {
  const credentialDefaults = options.allowServerDefaults === false
    ? { apiKey: "", ttsApiKey: "", modelProviders: [] }
    : DEFAULT_AI_SETTINGS;
  const merged = {
    baseURL: overrides.baseURL || DEFAULT_AI_SETTINGS.baseURL,
    apiKey: overrides.apiKey || credentialDefaults.apiKey,
    model: overrides.model || overrides.defaultModel || DEFAULT_AI_SETTINGS.defaultModel,
    modelOptions: overrides.modelOptions || DEFAULT_AI_SETTINGS.modelOptions,
    smallModel: overrides.smallModel || DEFAULT_AI_SETTINGS.smallModel,
    smallModelOptions: overrides.smallModelOptions || DEFAULT_AI_SETTINGS.smallModelOptions,
    ttsBaseURL: overrides.ttsBaseURL || DEFAULT_AI_SETTINGS.ttsBaseURL,
    ttsApiKey: overrides.ttsApiKey || credentialDefaults.ttsApiKey || overrides.apiKey || credentialDefaults.apiKey,
    ttsModel: overrides.ttsModel || DEFAULT_AI_SETTINGS.ttsModel,
    ttsVoice: overrides.ttsVoice || DEFAULT_AI_SETTINGS.ttsVoice,
    systemPrompt: overrides.systemPrompt || DEFAULT_AI_SETTINGS.systemPrompt,
    customActions: overrides.customActions || DEFAULT_CUSTOM_ACTIONS,
    // Per-model credential overrides forwarded from the client. See
    // resolveProviderForModel below. v1.2.1：客户端没传时回落到后端默认（在
    // defaults.js 里基于 AI_DEEPSEEK_PRO_API_KEY 等环境变量构建）。
    modelProviders: Array.isArray(overrides.modelProviders) && overrides.modelProviders.length
      ? overrides.modelProviders
      : (credentialDefaults.modelProviders || [])
  };

  merged.baseURL = normalizeBaseUrl(merged.baseURL);
  merged.ttsBaseURL = normalizeBaseUrl(merged.ttsBaseURL || merged.baseURL);
  return merged;
}

// Look up the (baseURL, apiKey) pair to use for a given model name.
// First match wins; falls back to the settings' default when no provider
// claims the model.
function resolveProviderForModel(settings, modelName) {
  const providers = settings.modelProviders || [];
  for (const p of providers) {
    if (!p?.apiKey || !p?.baseURL) continue;
    if (Array.isArray(p.models) && p.models.includes(modelName)) {
      return { baseURL: normalizeBaseUrl(p.baseURL), apiKey: p.apiKey };
    }
  }
  return { baseURL: settings.baseURL, apiKey: settings.apiKey };
}

export function aiReady(settings) {
  return Boolean(settings?.apiKey && settings?.baseURL && settings?.model);
}

function createClient(settings) {
  return new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    timeout: CHAT_COMPLETION_TIMEOUT_MS
  });
}

function buildModelQueue(settings, strategy = "large") {
  if (strategy === "small") {
    return unique([settings.smallModel, ...(settings.smallModelOptions || []), settings.model, settings.defaultModel]);
  }

  return unique([settings.model, settings.defaultModel, ...(settings.modelOptions || []), settings.smallModel]);
}

function isAuthenticationError(error) {
  const status = error?.status;
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  return (
    status === 401 ||
    status === 403 ||
    /AuthenticationError|PermissionDeniedError/i.test(name) ||
    /incorrect api key|unauthorized|authentication|apikey/i.test(message)
  );
}

function isTimeoutError(error) {
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return (
    /APITimeoutError|TimeoutError|AbortError/i.test(name) ||
    /ETIMEDOUT|ECONNRESET|ECONNABORTED/i.test(code) ||
    /timeout|timed out|aborted/i.test(message)
  );
}

function formatModelError(error, attemptedModels) {
  if (!error) {
    return new Error("AI 服务调用失败。");
  }

  const attempted = attemptedModels.join(" -> ");
  const message = String(error.message || "AI 服务调用失败。");
  return new Error(`${message}（已尝试模型：${attempted}）`);
}

export async function chatCompletion(messages, settings, extra = {}) {
  const models = buildModelQueue(settings, extra.modelStrategy || "large");
  const attemptedModels = [];
  // Cache one OpenAI client per (baseURL, apiKey) tuple so repeated retries
  // against the same provider don't allocate new sockets.
  const clientCache = new Map();
  const getClient = (baseURL, apiKey) => {
    // 用 \u0000 作分隔符：baseURL 和 apiKey 里都不可能出现它，拼出的缓存键
    // 不会歧义。写成转义序列而非字面 NUL —— 后者会让 git 把整个文件判成二进制，
    // 从此 diff 不可读、grep 静默失效（本文件此前正是如此）。
    // A \u0000 separator: neither value can contain it, so the composed cache
    // key is unambiguous. Written as an escape rather than a literal NUL byte,
    // which makes git treat the file as binary — leaving its diffs unreadable
    // and grep silently empty, as was the case here until now.
    const key = `${baseURL}\u0000${apiKey}`;
    let client = clientCache.get(key);
    if (!client) {
      client = new OpenAI({ apiKey, baseURL, timeout: CHAT_COMPLETION_TIMEOUT_MS });
      clientCache.set(key, client);
    }
    return client;
  };

  for (const model of models) {
    attemptedModels.push(model);
    const provider = resolveProviderForModel(settings, model);
    const client = getClient(provider.baseURL, provider.apiKey);

    try {
      // 小模型位置关思维链：走 /v1/completions 裸接口 + 预闭合 think 块。
      // 主模型位置照常走 chat 接口，保留思维链 —— 解读、比对这类任务需要它。
      // 名单见 defaults.js 的 NO_THINKING_AS_SMALL，只对确认支持这套模板的模型
      // 生效，别家 API 一律走标准 chat 路径。
      //
      // The small slot bypasses the chat endpoint (see renderMinimaxPrompt);
      // the main slot keeps chat completions and its reasoning, which the
      // interpretation and comparison tasks genuinely use. Gated on the
      // configured model list so no other provider ever sees this prompt shape.
      const suppressThinking = (extra.modelStrategy || "large") === "small" && NO_THINKING_AS_SMALL.has(model);

      let rawText;
      let usage;
      if (suppressThinking) {
        const completion = await client.completions.create({
          model,
          prompt: renderMinimaxPrompt(messages),
          temperature: extra.temperature ?? 0.3,
          max_tokens: extra.maxTokens ?? 1200,
          stop: MINIMAX_STOP
        });
        rawText = completion.choices?.[0]?.text;
        usage = completion.usage;
      } else {
        const response = await client.chat.completions.create({
          model,
          messages,
          temperature: extra.temperature ?? 0.3,
          max_tokens: extra.maxTokens ?? 1200
        });
        rawText = response.choices?.[0]?.message?.content;
        usage = response.usage;
      }

      return {
        // 唯一的正文出口 —— <think> 在这里剥掉，下游全部调用方都受益。
        // The single place a completion's text leaves this module, so
        // stripping here covers every caller including the JSON-parsing ones.
        text: stripReasoningBlocks(rawText),
        model,
        usage: usage || null
      };
    } catch (error) {
      const timedOut = isTimeoutError(error);
      const errSummary = `${error?.name || ''}${error?.status ? ' ' + error.status : ''}: ${String(error?.message || '').slice(0, 120)}`;

      // Auth errors used to abort the whole chain. With per-model providers
      // a 401 on one provider doesn't imply the next model's provider is
      // also broken, so only abort if every remaining model shares the same
      // failing credentials.
      if (isAuthenticationError(error)) {
        console.warn(`[ai] auth error on ${model}: ${errSummary}`);
        const remaining = models.slice(attemptedModels.length);
        const allSameCreds = remaining.every((m) => {
          const next = resolveProviderForModel(settings, m);
          return next.baseURL === provider.baseURL && next.apiKey === provider.apiKey;
        });
        if (allSameCreds) throw formatModelError(error, attemptedModels);
      } else if (timedOut) {
        console.warn(`[ai] TIMEOUT on ${model} (${CHAT_COMPLETION_TIMEOUT_MS}ms) — falling back to next model`);
      } else {
        console.warn(`[ai] error on ${model}: ${errSummary}`);
      }

      if (attemptedModels.length >= models.length) {
        throw formatModelError(error, attemptedModels);
      }
    }
  }

  throw formatModelError(null, attemptedModels);
}

function formatContext(contextSnippets = []) {
  if (!contextSnippets.length) return "暂无可用上下文。";
  return contextSnippets
    .map((item) => `【片段 ${item.index}｜${item.chapterTitle}】\n${item.snippet}`)
    .join("\n\n");
}

export function getActionPrompt(type) {
  return ACTION_PROMPTS[type] || null;
}

export async function runPromptTemplate({
  prompt,
  variables = {},
  aiSettings,
  temperature = 0.2,
  maxTokens = 1200,
  includeReaderSystem = true,
  modelStrategy = "large"
}) {
  const settings = resolveAiSettings(aiSettings);
  if (!aiReady(settings)) {
    throw new Error("AI 配置不完整，请在设置中检查 API Base URL、API Key 和模型。");
  }

  const content = fillTemplate(prompt.userTemplate, variables);
  const messages = [];

  if (includeReaderSystem && settings.systemPrompt) {
    messages.push({ role: "system", content: settings.systemPrompt });
  }
  if (prompt.system) {
    messages.push({ role: "system", content: prompt.system });
  }
  messages.push({ role: "user", content });

  const result = await chatCompletion(messages, settings, { temperature, maxTokens, modelStrategy });
  return {
    text: result.text,
    model: result.model,
    usage: result.usage
  };
}

export async function runStructuredJsonPrompt({ prompt, variables = {}, aiSettings, temperature = 0.1, maxTokens = 500, modelStrategy = "small" }) {
  const result = await runPromptTemplate({
    prompt,
    variables,
    aiSettings,
    temperature,
    maxTokens,
    modelStrategy
  });

  return {
    data: safeJsonParse(result.text),
    model: result.model,
    usage: result.usage
  };
}

export async function expandSearchIntent(question, settings) {
  const merged = resolveAiSettings(settings);
  if (!aiReady(merged)) {
    return {
      keywords: [],
      people: [],
      timeHints: [],
      events: [],
      searchQueries: [],
      note: "AI 未启用，跳过语义扩展。"
    };
  }

  const prompt = ACTION_PROMPTS.searchIntent;
  const content = fillTemplate(prompt.userTemplate, { question });
  const text = await chatCompletion(
    [
      { role: "system", content: prompt.system },
      { role: "user", content }
    ],
    merged,
    { temperature: 0.1, maxTokens: 500, modelStrategy: "small" }
  );

  return safeJsonParse(text.text);
}

export async function runReaderAction(payload) {
  const {
    type,
    selection = "",
    question = "",
    person = "",
    contextSnippets = [],
    aiSettings,
    customAction
  } = payload;

  const settings = resolveAiSettings(aiSettings);
  if (!aiReady(settings)) {
    throw new Error("AI 配置不完整，请在设置中检查 API Base URL、API Key 和模型。");
  }

  const prompt = type === "custom" ? customAction : ACTION_PROMPTS[type];
  if (!prompt) {
    throw new Error(`不支持的 AI 操作：${type}`);
  }

  const content = fillTemplate(prompt.userTemplate, {
    selection,
    question,
    person,
    context: formatContext(contextSnippets)
  });

  const messages = [
    { role: "system", content: settings.systemPrompt },
    { role: "system", content: prompt.system },
    { role: "user", content }
  ];

  // Punctuate: output is roughly the same length as input plus punctuation,
  // but in tokens that often doubles (each Chinese char ≈ 1-2 tokens). Long
  // passages need plenty of headroom or the model truncates mid-sentence
  // and the user sees "no marks added".
  const maxTokens = type === "pronounce" ? 900
    : type === "punctuate" ? 4000
    : 1300;
  // 句读 / 读音 / 翻译 are mechanical, low-creativity tasks — small model is
  // both faster and cheaper, and quality on these tasks matches the large
  // model in practice. Keep "large" for explanation / qa / custom which
  // benefit from the deeper reasoning.
  const SMALL_MODEL_TYPES = new Set(["punctuate", "pronounce", "translate"]);
  const result = await chatCompletion(messages, settings, {
    temperature: type === "qa" ? 0.2 : type === "punctuate" ? 0.15 : 0.35,
    maxTokens,
    modelStrategy: SMALL_MODEL_TYPES.has(type) ? "small" : "large"
  });

  return {
    answer: result.text,
    model: result.model
  };
}

export async function synthesizeSpeech(text, aiSettings) {
  const settings = resolveAiSettings(aiSettings);
  // TTS may use a separate API key (e.g. DashScope for TTS, Volcengine for LLM)
  const ttsKey = settings.ttsApiKey || settings.apiKey;
  if (!ttsKey || !settings.ttsModel) {
    throw new Error("TTS 配置不完整。");
  }

  const isDashScope = (settings.ttsBaseURL || settings.baseURL || "").includes("dashscope.aliyuncs.com");

  if (isDashScope) {
    return synthesizeDashScopeTts(text, { ...settings, apiKey: ttsKey });
  }

  // OpenAI 兼容接口
  const ttsBase = settings.ttsBaseURL || settings.baseURL;
  const response = await fetch(`${ttsBase}/audio/speech`, {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: `Bearer ${ttsKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.ttsModel,
      input: text,
      voice: settings.ttsVoice || "alloy",
      format: "mp3"
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`TTS 调用失败：${response.status} ${detail}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeDashScopeTts(text, settings) {
  const { execFileSync } = await import("node:child_process");

  // DashScope qwen3-tts 用原生 multimodal API
  const body = JSON.stringify({
    model: settings.ttsModel || "qwen3-tts-flash",
    input: { text },
    parameters: { voice: settings.ttsVoice || "Cherry", format: "wav" }
  });

  // 用 curl 避免 Node fetch 的 DNS/timeout 问题
  let responseText;
  try {
    responseText = execFileSync("curl", [
      "-s", "-L", "--max-time", "30",
      "-X", "POST",
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      "-H", `Authorization: Bearer ${settings.apiKey}`,
      "-H", "Content-Type: application/json",
      "-d", body
    ], { maxBuffer: 10 * 1024 * 1024, encoding: "utf8" });
  } catch {
    throw new Error("DashScope TTS 请求失败。");
  }

  const data = JSON.parse(responseText);
  if (data.code || data.error) {
    throw new Error(`DashScope TTS 错误：${data.message || data.error?.message || "未知错误"}`);
  }

  const audioUrl = data.output?.audio?.url;
  const audioData = data.output?.audio?.data;

  if (audioData) {
    return Buffer.from(audioData, "base64");
  }

  if (audioUrl) {
    // 下载音频文件
    try {
      const audioBytes = execFileSync("curl", ["-sL", "--max-time", "15", audioUrl], { maxBuffer: 10 * 1024 * 1024 });
      return Buffer.from(audioBytes);
    } catch {
      throw new Error("DashScope TTS 音频下载失败。");
    }
  }

  throw new Error("DashScope TTS 未返回音频数据。");
}
