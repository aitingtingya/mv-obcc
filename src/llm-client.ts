import { requestUrl } from "obsidian";
import type { LlmFeatureSettings, LlmPromptTemplate, LlmProviderType, LlmThinkingMode } from "./types";

/**
 * Call an OpenAI- or Anthropic-compatible chat completion endpoint.
 *
 * This module is intentionally independent from the Claude Code bridge: it only
 * performs an outbound HTTP request and returns plain text. It never touches the
 * bridge server, JSON-RPC, MCP registration, or any other part of the plugin.
 */

/** A fully-resolved connection target: which provider type, endpoint, key, model. */
export interface LlmRequestTarget {
  type: LlmProviderType;
  baseUrl: string;
  apiKey: string;
  /** Actual model string sent to the API. */
  model: string;
  /** Per-template thinking mode. "default" sends nothing (safe). */
  thinkingMode: LlmThinkingMode;
  /** Custom thinking JSON (only meaningful when thinkingMode === "custom"). */
  thinkingCustom?: string;
  /**
   * When true, route through Obsidian's requestUrl (bypasses CORS). When false,
   * use the streaming global fetch.
   */
  useProxy: boolean;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.replace(/\/+$/, "");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("LLM request aborted", "AbortError");
}

async function readError(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    detail = text ? `: ${text}` : "";
  } catch {
    // ignore body read failures
  }
  return `LLM 请求失败 (HTTP ${response.status})${detail}`;
}

function extractOpenAiContent(json: unknown): string {
  const data = json as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data?.choices?.[0]?.message?.content ?? "";
}

function extractAnthropicContent(json: unknown): string {
  const data = json as {
    content?: Array<{ type: string; text?: string }>;
  };
  const block = data?.content?.find((it) => it.type === "text");
  return block?.text ?? "";
}

/** Pull a single incremental text fragment out of one SSE `data:` payload. */
function extractOpenAiDelta(payload: unknown): string {
  const data = payload as {
    choices?: Array<{ delta?: { content?: string } }>;
  };
  return data?.choices?.[0]?.delta?.content ?? "";
}

function extractAnthropicDelta(payload: unknown): string {
  const data = payload as {
    delta?: { type?: string; text?: string };
  };
  if (data?.delta?.type === "text_delta") return data.delta.text ?? "";
  return "";
}

/** Parse one SSE event block into a text delta ("" if not a text fragment). */
function parseSseEvent(
  rawEvent: string,
  extractDelta: (payload: unknown) => string,
): string {
  const lines = rawEvent.split("\n");
  let dataLine = "";
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLine += line.slice(5).trimStart();
    }
  }
  dataLine = dataLine.trim();
  if (!dataLine || dataLine === "[DONE]") return "";
  try {
    const payload = JSON.parse(dataLine);
    return extractDelta(payload);
  } catch {
    return "";
  }
}

/**
 * Pure helper function to parse complete SSE text blocks.
 * Extracts and returns deltas in sequence.
 */
export function parseSseText(
  text: string,
  extractDelta: (payload: unknown) => string,
): string[] {
  const deltas: string[] = [];
  const rawEvents = text.split("\n\n");
  for (const rawEvent of rawEvents) {
    if (!rawEvent.trim()) continue;
    const delta = parseSseEvent(rawEvent, extractDelta);
    if (delta) {
      deltas.push(delta);
    }
  }
  return deltas;
}

/**
 * Resolve the configured thinking mode into a JSON object to merge into the
 * request body, or null when nothing should be added.
 */
export function resolveThinkingParams(
  mode: LlmThinkingMode,
  customJson: string | undefined,
): Record<string, unknown> | null {
  if (mode === "on") return { thinking: { type: "enabled" } };
  if (mode === "off") return { thinking: { type: "disabled" } };
  if (mode === "custom") {
    const raw = (customJson ?? "").trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error("自定义思考参数必须是 JSON 对象");
    } catch (error) {
      throw new Error(
        `自定义思考参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return null;
}

/**
 * Resolve a template's chosen provider + model into a concrete request target.
 */
export function resolveProvider(
  settings: LlmFeatureSettings,
  template: LlmPromptTemplate,
): LlmRequestTarget {
  if (!template.providerId) {
    throw new Error(`模板「${template.label}」尚未选择模型，请在设置中为其指定提供商与模型。`);
  }
  const provider = settings.providers.find((p) => p.id === template.providerId);
  if (!provider) {
    throw new Error(`模板「${template.label}」引用的提供商已不存在，请在设置中重新选择模型。`);
  }
  if (!template.modelId) {
    throw new Error(`模板「${template.label}」尚未选择模型。`);
  }
  const model = provider.models.find((m) => m.id === template.modelId);
  if (!model) {
    throw new Error(`模板「${template.label}」引用的模型已不存在，请在设置中重新选择。`);
  }
  if (!provider.apiKey.trim()) {
    throw new Error(`提供商「${provider.name}」未配置 API Key。`);
  }
  if (!provider.baseUrl.trim()) {
    throw new Error(`提供商「${provider.name}」未配置 API Base URL。`);
  }
  return {
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: model.name,
    thinkingMode: template.thinkingMode ?? "default",
    thinkingCustom: template.thinkingCustom,
    useProxy: provider.useProxy === true,
  };
}

/** Build request URL, headers, and body for the API. */
function buildRequest(
  target: LlmRequestTarget,
  model: string,
  userMessage: string,
  stream: boolean,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = normalizeBaseUrl(target.baseUrl);
  const isAnthropic = target.type === "anthropic";
  const url = isAnthropic ? `${base}/v1/messages` : `${base}/chat/completions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (stream) {
    headers.accept = "text/event-stream";
  }

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: userMessage }],
  };
  if (stream) {
    body.stream = true;
  }

  if (isAnthropic) {
    headers["x-api-key"] = target.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body.max_tokens = 2048;
  } else {
    headers.authorization = `Bearer ${target.apiKey}`;
  }

  const thinkingParams = resolveThinkingParams(target.thinkingMode, target.thinkingCustom);
  if (thinkingParams) {
    Object.assign(body, thinkingParams);
  }

  return { url, headers, body };
}

/**
 * Send a single user message to the configured provider and return the model's
 * reply text. Throws an Error with a human-readable message on any failure.
 */
export async function callLlm(
  target: LlmRequestTarget,
  userMessage: string,
): Promise<string> {
  if (!userMessage.trim()) {
    throw new Error("没有可发送的内容（选区为空）。");
  }
  const model = target.model.trim();
  if (!model) throw new Error("未配置模型名称。");
  if (!target.apiKey.trim()) throw new Error("未配置 API Key。");
  if (!target.baseUrl.trim()) throw new Error("未配置 API Base URL。");

  const { url, headers, body } = buildRequest(target, model, userMessage, false);

  if (target.useProxy) {
    const response = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`LLM 请求失败 (HTTP ${response.status})${response.text ? `: ${response.text}` : ""}`);
    }
    return target.type === "anthropic"
      ? extractAnthropicContent(response.json)
      : extractOpenAiContent(response.json);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  return target.type === "anthropic"
    ? extractAnthropicContent(await response.json())
    : extractOpenAiContent(await response.json());
}

/**
 * Streaming variant. Invokes `onDelta` for each incremental text fragment as
 * the SSE stream arrives and resolves with the full concatenated text.
 */
export async function callLlmStream(
  target: LlmRequestTarget,
  userMessage: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (!userMessage.trim()) {
    throw new Error("没有可发送的内容（选区为空）。");
  }
  const model = target.model.trim();
  if (!model) throw new Error("未配置模型名称。");
  if (!target.apiKey.trim()) throw new Error("未配置 API Key。");
  if (!target.baseUrl.trim()) throw new Error("未配置 API Base URL。");

  const extractDelta = target.type === "anthropic" ? extractAnthropicDelta : extractOpenAiDelta;

  if (target.useProxy) {
    const { url, headers, body } = buildRequest(target, model, userMessage, true);
    const response = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
    throwIfAborted(signal);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`LLM 请求失败 (HTTP ${response.status})${response.text ? `: ${response.text}` : ""}`);
    }
    const text = response.text ?? "";
    if (text.includes("data:")) {
      let full = "";
      const deltas = parseSseText(text, extractDelta);
      for (const delta of deltas) {
        throwIfAborted(signal);
        full += delta;
        onDelta(delta);
      }
      if (full) return full;
    }

    // Endpoint ignored stream:true or returned plain JSON
    try {
      const json = typeof response.json === "object" ? response.json : JSON.parse(text);
      const full = target.type === "anthropic" ? extractAnthropicContent(json) : extractOpenAiContent(json);
      throwIfAborted(signal);
      if (full) onDelta(full);
      return full;
    } catch {
      throwIfAborted(signal);
      if (text) onDelta(text);
      return text;
    }
  }

  // Native streaming path
  const { url, headers, body } = buildRequest(target, model, userMessage, true);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));

  if (!response.body) {
    const json = await response.json();
    const full = target.type === "anthropic" ? extractAnthropicContent(json) : extractOpenAiContent(json);
    if (full) onDelta(full);
    return full;
  }

  return readEventStream(response.body, extractDelta, onDelta, signal);
}

/** Parse a Server-Sent-Events stream, invoking onDelta per text fragment. */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  extractDelta: (payload: unknown) => string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const delta = parseSseEvent(rawEvent, extractDelta);
        if (delta) {
          full += delta;
          onDelta(delta);
        }
        sep = buffer.indexOf("\n\n");
      }
    }
    throwIfAborted(signal);
    if (buffer.trim()) {
      const delta = parseSseEvent(buffer, extractDelta);
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
    return full;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
