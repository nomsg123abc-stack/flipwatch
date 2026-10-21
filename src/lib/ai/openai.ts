import type Anthropic from "@anthropic-ai/sdk";
import type { AiClient } from "./client";
import { AiRequestError, redactSecrets } from "./errors";
import { asMessage, outputSchema, systemText } from "./request-parts";

/**
 * AI engine "openai": the user's own OpenAI API key, through the Chat Completions endpoint. Requests arrive
 * in the Anthropic Messages shape: system prompt, text and image blocks, a JSON Schema for the answer.
 * Plain fetch (no SDK) so there is nothing extra to install.
 */

export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ChatPart[] };

function imageUrl(block: Anthropic.ImageBlockParam): string | null {
  const source = block.source as { type: string; url?: string; media_type?: string; data?: string };
  if (source.type === "url" && source.url) return source.url;
  if (source.type === "base64" && source.data) return `data:${source.media_type ?? "image/jpeg"};base64,${source.data}`;
  return null;
}

export function toChatMessages(body: Anthropic.MessageCreateParamsNonStreaming): ChatMessage[] {
  const out: ChatMessage[] = [];
  const system = systemText(body.system);
  if (system) out.push({ role: "system", content: system });
  for (const message of body.messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    const parts: ChatPart[] = [];
    for (const block of message.content) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        const url = imageUrl(block);
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
    }
    out.push({ role: message.role, content: message.role === "user" ? parts : parts.map((p) => (p.type === "text" ? p.text : "")).join("\n") });
  }
  return out;
}

export function toChatRequest(body: Anthropic.MessageCreateParamsNonStreaming): Record<string, unknown> {
  const schema = outputSchema(body);
  return {
    model: body.model,
    messages: toChatMessages(body),
    max_completion_tokens: body.max_tokens,
    ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: false } } } : {}),
  };
}

interface ChatResponse {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

function errorFor(status: number, body: ChatResponse | null, providerName: string): AiRequestError {
  const detail = body?.error?.message ? redactSecrets(body.error.message.replace(/\s+/g, " ")).slice(0, 160) : "";
  if (status === 401) return new AiRequestError(`${providerName} rejected the API key — check it in Settings → AI`, { status });
  if (status === 404) return new AiRequestError(`${providerName} doesn't know this model${detail ? `: ${detail}` : ""} — pick another in Settings → AI`, { status });
  if (status === 429) return new AiRequestError(`${providerName} rate limit or quota reached${detail ? `: ${detail}` : ""}`, { status });
  return new AiRequestError(`${providerName} API error ${status}${detail ? `: ${detail}` : ""}`, { status });
}

/** Validate and normalize a base URL for an OpenAI Chat Completions-compatible service. */
export function normalizeOpenAiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid base URL, for example http://10.213.13.137:20128/v1.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an http:// or https:// base URL without credentials, query parameters or a fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createOpenAiClient(apiKey: string, fetchImpl: typeof fetch = fetch, baseUrl = "https://api.openai.com/v1", providerName = "OpenAI"): AiClient {
  return {
    messages: {
      async create(body, options) {
        const request = JSON.stringify(toChatRequest(body));
        let lastError: AiRequestError | null = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const signals = [AbortSignal.timeout(TIMEOUT_MS), options?.signal].filter(Boolean) as AbortSignal[];
          let res: Response;
          try {
            res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: request,
              signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
            });
          } catch (err) {
            if (options?.signal?.aborted) throw new AiRequestError("OpenAI request was aborted", { cause: err });
            lastError = new AiRequestError(err instanceof Error && err.name === "TimeoutError" ? "OpenAI request timed out" : "Could not reach the OpenAI API", { cause: err });
            if (attempt < MAX_ATTEMPTS) await sleep(1_000 * 2 ** attempt);
            continue;
          }
          const json = (await res.json().catch(() => null)) as ChatResponse | null;
          if (!res.ok) {
            lastError = errorFor(res.status, json, providerName);
            // Rate limits and server errors are worth retrying; a bad key or model is not.
            if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
              await sleep(1_000 * 2 ** attempt);
              continue;
            }
            throw lastError;
          }
          const choice = json?.choices?.[0];
          const usage = { inputTokens: json?.usage?.prompt_tokens, outputTokens: json?.usage?.completion_tokens };
          if (choice?.message?.refusal) return asMessage(body.model, "", { stop: "refusal", ...usage });
          const stop: Anthropic.Message["stop_reason"] = choice?.finish_reason === "length" ? "max_tokens" : "end_turn";
          return asMessage(body.model, choice?.message?.content ?? "", { stop, ...usage });
        }
        throw lastError ?? new AiRequestError("OpenAI request failed");
      },
    },
  };
}
