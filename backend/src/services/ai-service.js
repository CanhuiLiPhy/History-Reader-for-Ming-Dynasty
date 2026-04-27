import OpenAI from "openai";
import { ACTION_PROMPTS, DEFAULT_CUSTOM_ACTIONS } from "../config/prompts.js";
import { DEFAULT_AI_SETTINGS } from "../config/defaults.js";

const CHAT_COMPLETION_TIMEOUT_MS = 60000;

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

export function resolveAiSettings(overrides = {}) {
  const merged = {
    baseURL: overrides.baseURL || DEFAULT_AI_SETTINGS.baseURL,
    apiKey: overrides.apiKey || DEFAULT_AI_SETTINGS.apiKey,
    model: overrides.model || overrides.defaultModel || DEFAULT_AI_SETTINGS.defaultModel,
    modelOptions: overrides.modelOptions || DEFAULT_AI_SETTINGS.modelOptions,
    smallModel: overrides.smallModel || DEFAULT_AI_SETTINGS.smallModel,
    smallModelOptions: overrides.smallModelOptions || DEFAULT_AI_SETTINGS.smallModelOptions,
    ttsBaseURL: overrides.ttsBaseURL || DEFAULT_AI_SETTINGS.ttsBaseURL,
    ttsApiKey: overrides.ttsApiKey || DEFAULT_AI_SETTINGS.ttsApiKey || overrides.apiKey || DEFAULT_AI_SETTINGS.apiKey,
    ttsModel: overrides.ttsModel || DEFAULT_AI_SETTINGS.ttsModel,
    ttsVoice: overrides.ttsVoice || DEFAULT_AI_SETTINGS.ttsVoice,
    systemPrompt: overrides.systemPrompt || DEFAULT_AI_SETTINGS.systemPrompt,
    customActions: overrides.customActions || DEFAULT_CUSTOM_ACTIONS
  };

  merged.baseURL = normalizeBaseUrl(merged.baseURL);
  merged.ttsBaseURL = normalizeBaseUrl(merged.ttsBaseURL || merged.baseURL);
  return merged;
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

function formatModelError(error, attemptedModels) {
  if (!error) {
    return new Error("AI 服务调用失败。");
  }

  const attempted = attemptedModels.join(" -> ");
  const message = String(error.message || "AI 服务调用失败。");
  return new Error(`${message}（已尝试模型：${attempted}）`);
}

async function chatCompletion(messages, settings, extra = {}) {
  const client = createClient(settings);
  const models = buildModelQueue(settings, extra.modelStrategy || "large");
  const attemptedModels = [];

  for (const model of models) {
    attemptedModels.push(model);

    try {
      const response = await client.chat.completions.create({
        model,
        messages,
        temperature: extra.temperature ?? 0.3,
        max_tokens: extra.maxTokens ?? 1200
      });

      return {
        text: response.choices?.[0]?.message?.content?.trim() || "",
        model,
        usage: response.usage || null
      };
    } catch (error) {
      if (isAuthenticationError(error)) {
        throw formatModelError(error, attemptedModels);
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

  const result = await chatCompletion(messages, settings, {
    temperature: type === "qa" ? 0.2 : 0.35,
    maxTokens: type === "pronounce" ? 900 : 1300,
    modelStrategy: "large"
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
    signal: AbortSignal.timeout(30000),
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
