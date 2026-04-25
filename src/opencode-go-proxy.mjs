import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const configDir = path.join(rootDir, ".javiproxy");
const configPath = path.join(configDir, "config.json");
const logPath = path.join(configDir, "logs", "proxy-debug.jsonl");

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

let config = await loadConfig();
const logger = createProxyLogger(logPath, "standalone");

const TOOL_BRIDGE_SYSTEM_PROMPT = [
  "You are connected to Claude Code through JaviProxy.",
  "Use the native OpenAI tool_calls/function-calling channel whenever you need a tool.",
  "When tools are available and the next step requires file inspection, editing, or commands, call the tool immediately instead of narrating intent.",
  "Do not write <tool_use>, <tool_result>, JSON tool envelopes, or bare tool names as normal assistant text.",
  "Historical <tool_use> and <tool_result> tags in the transcript are summaries of already executed tools; do not copy that format.",
].join("\n");

const TOOL_CALL_REASONING_REPLAY = "Bridge replay: original reasoning unavailable.";
const MISSING_TOOL_CALL_RETRY_PROMPT = [
  "Your previous reply described the next action instead of calling a tool.",
  "If the task is not complete and tools are available, do not narrate the next step.",
  "Call the next tool immediately.",
  "Only reply with normal assistant text if the task is complete or you need a blocking clarification from the user.",
].join("\n");

const server = http.createServer(async (req, res) => {
  let logContext = null;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "HEAD") {
      res.writeHead(200).end();
      return;
    }

    if (req.method === "GET" && ["/health", "/v1/health"].includes(url.pathname)) {
      sendJson(res, 200, statusPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, statusPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, publicConfig());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJson(req);
      config = normalizeConfig({ ...config, ...body });
      await saveConfig(config);
      sendJson(res, 200, publicConfig());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      sendJson(res, 200, await fetchModels());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/test") {
      sendJson(res, 200, await testUpstream());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/launch") {
      const body = await readJson(req);
      sendJson(res, 200, await launchClaude(body));
      return;
    }

    if (req.method === "GET" && ["/models", "/v1/models"].includes(url.pathname)) {
      await proxyModels(res);
      return;
    }

    if (req.method === "POST" && ["/messages", "/v1/messages"].includes(url.pathname)) {
      const body = await readJson(req);
      const requestId = `req_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      logContext = createLogContext(logger, requestId, req.method || "POST", url.pathname);
      res.setHeader("x-javiproxy-request-id", requestId);
      logContext.log("anthropic_request", {
        summary: summarizeAnthropicRequest(body),
        headers: {
          "anthropic-version": req.headers["anthropic-version"],
          "anthropic-beta": req.headers["anthropic-beta"],
          "user-agent": req.headers["user-agent"],
        },
        body,
      });
      if (body.stream) {
        await sendAnthropicStream(req, res, body, logContext);
      } else {
        const response = await createMessage(body, logContext);
        const anthropic = toAnthropicMessage(response, body);
        logContext.log("anthropic_response", {
          summary: summarizeAnthropicResponse(anthropic),
          body: anthropic,
          delivery: "json",
        });
        sendJson(res, 200, anthropic);
      }
      return;
    }

    if (req.method === "GET") {
      await serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 404, anthropicError("not_found_error", `Unsupported route: ${req.method} ${url.pathname}`));
  } catch (error) {
    logContext?.log("error", {
      status: Number(error?.status || 500),
      message: error?.message || String(error),
    });
    const status = Number(error?.status || 500);
    if (res.headersSent) {
      if (!res.writableEnded) {
        writeEvent(res, "error", anthropicError("api_error", error?.message || String(error)));
        res.end();
      }
      return;
    }
    sendJson(res, status, anthropicError("api_error", error?.message || String(error)));
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${host}:${port} is already in use. Set PORT=8788 or stop the existing process.`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, host, () => {
  console.error(`JaviProxy listening on http://${host}:${port}`);
  console.error(`Proxy endpoint for Claude Code: http://${host}:${port}/v1/messages`);
  console.error(`Upstream: ${config.upstreamBase}/chat/completions, model: ${effectiveModel()}`);
});

async function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    fileConfig = {};
  }

  return normalizeConfig({
    upstreamBase: "https://opencode.ai/zen/go/v1",
    apiKey: "",
    model: "kimi-k2.6",
    fastModel: "minimax-m2.5",
    forceModel: true,
    modelMapJson: "",
    ...fileConfig,
    ...(process.env.OPENCODE_BASE_URL ? { upstreamBase: process.env.OPENCODE_BASE_URL } : {}),
    ...(process.env.OPENCODE_API_KEY || process.env.OPENCODE_GO_API_KEY
      ? { apiKey: process.env.OPENCODE_API_KEY || process.env.OPENCODE_GO_API_KEY }
      : {}),
    ...(process.env.OPENCODE_GO_MODEL ? { model: process.env.OPENCODE_GO_MODEL } : {}),
    ...(process.env.OPENCODE_GO_FAST_MODEL ? { fastModel: process.env.OPENCODE_GO_FAST_MODEL } : {}),
    ...(process.env.OPENCODE_FORCE_MODEL ? { forceModelValue: process.env.OPENCODE_FORCE_MODEL, forceModel: true } : {}),
    ...(process.env.OPENCODE_MODEL_MAP_JSON ? { modelMapJson: process.env.OPENCODE_MODEL_MAP_JSON } : {}),
  });
}

function normalizeConfig(value) {
  return {
    upstreamBase: normalizeGoBaseURL(String(value.upstreamBase || "https://opencode.ai/zen/go/v1")),
    apiKey: String(value.apiKey || ""),
    model: String(value.model || "kimi-k2.6"),
    fastModel: String(value.fastModel || "minimax-m2.5"),
    forceModel: Boolean(value.forceModel),
    forceModelValue: String(value.forceModelValue || value.model || "kimi-k2.6"),
    modelMapJson: String(value.modelMapJson || ""),
  };
}

async function saveConfig(nextConfig) {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2) + "\n", "utf8");
}

function publicConfig() {
  return {
    upstreamBase: config.upstreamBase,
    model: config.model,
    fastModel: config.fastModel,
    forceModel: config.forceModel,
    forceModelValue: config.forceModelValue,
    modelMapJson: config.modelMapJson,
    hasApiKey: Boolean(config.apiKey),
    maskedApiKey: maskKey(config.apiKey),
    logPath,
    configPath,
    platform: process.platform,
    commands: commandPayload(),
  };
}

function statusPayload() {
  return {
    ok: true,
    app: "JaviProxy",
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    claudeBaseUrl: `http://${host}:${port}`,
    claudeMessagesUrl: `http://${host}:${port}/v1/messages`,
    upstreamBase: config.upstreamBase,
    defaultModel: config.model,
    effectiveModel: effectiveModel(),
    forceModel: config.forceModel,
    hasApiKey: Boolean(config.apiKey),
    logPath,
    platform: process.platform,
  };
}

function commandPayload() {
  const base = `http://${host}:${port}`;
  return {
    mac: `cd "${rootDir}" && ./scripts/claude-opencode-go.sh --model claude-sonnet-4-6`,
    windows: `cd "${rootDir}" ; .\\scripts\\claude-opencode-go.ps1 --model claude-sonnet-4-6`,
    envMac: `export OPENCODE_PROXY_BASE_URL="${base}"`,
    envWindows: `$env:OPENCODE_PROXY_BASE_URL="${base}"`,
    endpoint: `${base}/v1/messages`,
  };
}

const GO_MODEL_IDS = [
  'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5', 'glm-5.1',
  'kimi-k2.5', 'kimi-k2.6', 'mimo-v2-omni', 'mimo-v2-pro',
  'mimo-v2.5', 'mimo-v2.5-pro', 'minimax-m2.5', 'minimax-m2.7',
  'qwen3.5-plus', 'qwen3.6-plus',
];

function displayNameToModelId(name) {
  return name.replace(/\s+/g, '-').toLowerCase()
    .replace(/^mimo-v2-5/, 'mimo-v2.5')
    .replace(/^glm-5-1$/, 'glm-5.1')
    .replace(/^qwen3-6/, 'qwen3.6')
    .replace(/^qwen3-5/, 'qwen3.5')
    .replace(/^minimax-m2-7$/, 'minimax-m2.7')
    .replace(/^minimax-m2-5$/, 'minimax-m2.5')
    .replace(/^kimi-k2-6$/, 'kimi-k2.6')
    .replace(/^kimi-k2-5$/, 'kimi-k2.5');
}

async function scrapeGoModels() {
  const response = await fetch('https://opencode.ai/go', {
    headers: { accept: 'text/html', 'user-agent': 'JaviProxy/1.0' },
  });
  if (!response.ok) return [];
  const html = await response.text();
  const match = html.match(/Includes\s+([\w\s.,\-]+(?:and\s+[\w\s.\-]+)?)/i);
  if (!match) return [];
  return match[1].replace(/\band\b/g, ',').split(',')
    .map((s) => s.trim()).filter(Boolean)
    .map(displayNameToModelId).filter(Boolean).sort();
}

async function fetchModels() {
  try {
    const response = await fetch(`${config.upstreamBase}/models`, {
      headers: upstreamHeaders(false),
    });
    const ct = response.headers.get('content-type') || '';
    if (response.ok && ct.includes('application/json')) {
      const json = await response.json();
      const models = Array.isArray(json?.data) ? json.data.map((m) => m.id).sort() : [];
      if (models.length) return { ok: true, models, raw: json };
    }
  } catch { /* fall through */ }
  try {
    const scraped = await scrapeGoModels();
    if (scraped.length) return { ok: true, models: scraped, raw: { source: 'scrape' } };
  } catch { /* fall through */ }
  return { ok: true, models: [...GO_MODEL_IDS], raw: { fallback: true } };
}

async function proxyModels(res) {
  const result = await fetchModels();
  const payload = { object: 'list', data: result.models.map((id) => ({ id, object: 'model', owned_by: 'opencode' })) };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function testUpstream() {
  if (!config.apiKey) {
    const error = new Error("Agrega tu API key de OpenCode Go antes de probar.");
    error.status = 400;
    throw error;
  }

  const response = await fetch(`${config.upstreamBase}/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(true),
    body: JSON.stringify({
      model: effectiveModel(),
      messages: [{ role: "user", content: "Responde solo: JaviProxy OK" }],
      max_tokens: 32,
      stream: false,
    }),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    const message = json?.error?.message || json?.message || text || response.statusText;
    const error = new Error(`OpenCode upstream error (${response.status}): ${message}`);
    error.status = response.status;
    throw error;
  }

  return {
    ok: true,
    model: effectiveModel(),
    message: json?.choices?.[0]?.message?.content || "",
    usage: json?.usage || null,
  };
}

async function createMessage(body, logContext) {
  if (!config.apiKey) {
    const error = new Error("Missing OpenCode Go API key. Open JaviProxy and save OPENCODE_API_KEY.");
    error.status = 401;
    throw error;
  }

  const request = toOpenAIChatCompletion(body, false);
  logContext?.log("openai_request", {
    summary: summarizeOpenAIRequest(request),
    body: request,
    delivery: "sync",
  });
  let response = await fetch(`${config.upstreamBase}/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(true),
    body: JSON.stringify(request),
  });

  let text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  logContext?.log("upstream_response", {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    body: json,
  });

  if (!response.ok) {
    const message = json?.error?.message || json?.message || text || response.statusText;
    const error = new Error(`OpenCode upstream error (${response.status}): ${message}`);
    error.status = response.status;
    throw error;
  }

  if (shouldRetryNarratedToolTurn(body, json)) {
    const retryBody = withExtraSystem(body, MISSING_TOOL_CALL_RETRY_PROMPT);
    const retryRequest = toOpenAIChatCompletion(retryBody, false);
    logContext?.log("tool_retry", {
      reason: "missing_tool_call",
      assistant_text: openAIContentToText(json?.choices?.[0]?.message?.content),
      request_summary: summarizeOpenAIRequest(retryRequest),
    });
    logContext?.log("openai_request_retry", {
      summary: summarizeOpenAIRequest(retryRequest),
      body: retryRequest,
      delivery: "sync_retry",
    });

    response = await fetch(`${config.upstreamBase}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(true),
      body: JSON.stringify(retryRequest),
    });

    text = await response.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    logContext?.log("upstream_response_retry", {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      body: json,
    });

    if (!response.ok) {
      const message = json?.error?.message || json?.message || text || response.statusText;
      const error = new Error(`OpenCode upstream error (${response.status}): ${message}`);
      error.status = response.status;
      throw error;
    }
  }

  return json;
}

async function createStreamResponse(body, signal, logContext) {
  if (!config.apiKey) {
    const error = new Error("Missing OpenCode Go API key. Open JaviProxy and save OPENCODE_API_KEY.");
    error.status = 401;
    throw error;
  }

  const request = toOpenAIChatCompletion(body, true);
  logContext?.log("openai_request", {
    summary: summarizeOpenAIRequest(request),
    body: request,
    delivery: "stream",
  });
  const response = await fetch(`${config.upstreamBase}/chat/completions`, {
    method: "POST",
    headers: { ...upstreamHeaders(true), accept: "text/event-stream" },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    logContext?.log("upstream_response", {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      body: json,
    });
    const message = json?.error?.message || json?.message || text || response.statusText;
    const error = new Error(`OpenCode upstream error (${response.status}): ${message}`);
    error.status = response.status;
    throw error;
  }

  logContext?.log("upstream_stream_open", {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
  });
  return response;
}

function toOpenAIChatCompletion(body, stream) {
  const model = resolveModel(body.model);
  const messages = [{
    role: "system",
    content: TOOL_BRIDGE_SYSTEM_PROMPT,
  }];

  if (body.system) {
    messages.push({
      role: "system",
      content: blocksToText(Array.isArray(body.system) ? body.system : [{ type: "text", text: String(body.system) }]),
    });
  }

  const toolChoiceInstruction = toolChoiceToInstruction(body.tool_choice);
  if (toolChoiceInstruction) {
    messages.push({
      role: "system",
      content: toolChoiceInstruction,
    });
  }

  for (const message of body.messages || []) {
    messages.push(...convertAnthropicMessage(message));
  }

  const request = {
    model,
    messages,
    stream,
  };

  if (body.max_tokens) request.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) request.stop = body.stop_sequences;

  const tools = convertTools(body.tools);
  if (tools.length) request.tools = tools;

  return request;
}

function withExtraSystem(body, extraSystem) {
  const existingSystem = Array.isArray(body?.system)
    ? body.system
    : body?.system
      ? [{ type: "text", text: String(body.system) }]
      : [];

  return {
    ...body,
    system: [
      ...existingSystem,
      { type: "text", text: extraSystem },
    ],
  };
}

function convertAnthropicMessage(message) {
  const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];

  if (message.role === "assistant") {
    const text = blocksToText(content.filter((block) => block.type === "text"));
    const toolCalls = content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id || `toolu_${randomUUID().replaceAll("-", "")}`,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));
    return [{
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { reasoning_content: TOOL_CALL_REASONING_REPLAY } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }];
  }

  const result = [];
  const userText = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: formatOpenAIToolResult(block),
      });
    } else {
      userText.push(block);
    }
  }

  if (userText.length) {
    result.push({ role: "user", content: blocksToText(userText) });
  }
  return result.length ? result : [{ role: "user", content: "" }];
}

function convertTools(tools = []) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  }));
}

function toolChoiceToInstruction(choice) {
  if (!choice) return undefined;
  if (choice.type === "none") return "For this turn, do not call any tools. Reply with normal assistant text.";
  if (choice.type === "any") return "For this turn, you must call exactly one available tool using the native tool_calls/function-calling channel.";
  if (choice.type === "tool" && choice.name) {
    return `For this turn, you must call the ${choice.name} tool using the native tool_calls/function-calling channel.`;
  }
  return undefined;
}

function toAnthropicMessage(openai, original) {
  const choice = openai?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (message.content) {
    content.push(...parseTaggedToolBlocks(openAIContentToText(message.content)));
  }

  for (const call of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${randomUUID().replaceAll("-", "")}`,
      name: call.function?.name || "tool",
      input: parseJson(call.function?.arguments || "{}", {}),
    });
  }

  if (!content.length) content.push({ type: "text", text: "" });

  return {
    id: openai.id || `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: original.model || "opencode-go",
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openai?.usage?.prompt_tokens || 0,
      output_tokens: openai?.usage?.completion_tokens || 0,
    },
  };
}

async function sendAnthropicStream(req, res, original, logContext) {
  if (shouldUseSyntheticStream(original)) {
    logContext?.log("stream_strategy", { mode: "synthetic_tool_turn" });
    const json = await createMessage(original, logContext);
    const anthropic = toAnthropicMessage(json, original);
    logContext?.log("anthropic_response", {
      summary: summarizeAnthropicResponse(anthropic),
      body: anthropic,
      delivery: "synthetic_stream",
    });
    sendAnthropicMessageAsStream(res, anthropic);
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  const state = {
    activeTextIndex: null,
    emittedText: [],
    messageId: `msg_${randomUUID().replaceAll("-", "")}`,
    nextIndex: 0,
    outputTokens: 0,
    sawContent: false,
    sawTool: false,
    stopReason: null,
    toolStates: new Map(),
  };
  let heartbeat = null;
  let started = false;

  req.once("close", abort);
  res.once("close", abort);

  try {
    let upstream;
    try {
      upstream = await createStreamResponse(original, controller.signal, logContext);
      logContext?.log("stream_strategy", { mode: "native_upstream_sse" });
    } catch (error) {
      if (!shouldFallbackToSyntheticStream(error)) throw error;
      logContext?.log("stream_strategy", {
        mode: "fallback_to_synthetic",
        reason: error?.message || String(error),
      });
      const json = await createMessage(original, logContext);
      const anthropic = toAnthropicMessage(json, original);
      logContext?.log("anthropic_response", {
        summary: summarizeAnthropicResponse(anthropic),
        body: anthropic,
        delivery: "synthetic_stream_after_error",
      });
      sendAnthropicMessageAsStream(res, anthropic);
      return;
    }
    const contentType = upstream.headers.get("content-type") || "";

    if (!contentType.includes("text/event-stream") || !upstream.body) {
      const text = await upstream.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      const anthropic = toAnthropicMessage(json, original);
      logContext?.log("stream_strategy", {
        mode: "fallback_to_synthetic_non_sse",
        contentType,
      });
      logContext?.log("upstream_response", {
        status: upstream.status,
        contentType,
        body: json,
      });
      logContext?.log("anthropic_response", {
        summary: summarizeAnthropicResponse(anthropic),
        body: anthropic,
        delivery: "synthetic_stream_non_sse",
      });
      sendAnthropicMessageAsStream(res, anthropic);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    started = true;

    writeEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: original.model || "opencode-go",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    heartbeat = setInterval(() => {
      if (!res.writableEnded) writeEvent(res, "ping", { type: "ping" });
    }, 10_000);

    const parser = createSseParser((data) => {
      if (!data || data === "[DONE]") return;
      const chunk = parseJson(data, null);
      if (!chunk) return;
      if (chunk?.error?.message) {
        const error = new Error(`OpenCode upstream error (502): ${chunk.error.message}`);
        error.status = 502;
        throw error;
      }
      logContext?.log("upstream_stream_chunk", {
        index: logContext.nextChunkIndex(),
        chunk,
      });
      applyOpenAIStreamChunk(res, chunk, state);
    });

    const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.feed(value);
    }
    parser.finish();

    finalizeAnthropicStream(res, state);
    logContext?.log("anthropic_stream_summary", summarizeAnthropicStreamState(state));
  } catch (error) {
    if (controller.signal.aborted) {
      logContext?.log("stream_aborted", { reason: "client_disconnected" });
      if (started && !res.writableEnded) res.end();
      return;
    }
    if (!started) throw error;
    if (!res.writableEnded) {
      logContext?.log("stream_error", { message: error?.message || String(error) });
      writeEvent(res, "error", anthropicError("api_error", error?.message || String(error)));
      res.end();
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    req.off("close", abort);
    res.off("close", abort);
  }
}

function sendAnthropicMessageAsStream(res, message) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  writeEvent(res, "message_start", {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } },
  });

  message.content.forEach((block, index) => {
    if (block.type === "tool_use") {
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
      });
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index });
      return;
    }

    writeEvent(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    if (block.text) {
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    }
    writeEvent(res, "content_block_stop", { type: "content_block_stop", index });
  });

  writeEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  });
  writeEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function openAIContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      if (typeof part?.text === "string") return part.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return String(content ?? "");
}

function applyOpenAIStreamChunk(res, chunk, state) {
  const usage = chunk?.usage || {};
  if (typeof usage.completion_tokens === "number") state.outputTokens = usage.completion_tokens;

  const choice = chunk?.choices?.[0] || {};
  if (choice.finish_reason) state.stopReason = mapStopReason(choice.finish_reason);

  const delta = choice.delta || {};
  const text = openAIContentToText(delta.content);
  if (text) {
    state.emittedText.push(text);
    const index = ensureTextBlock(res, state);
    writeEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    });
    state.sawContent = true;
  }

  if (delta.function_call) {
    applyToolCallDelta(res, { index: 0, function: delta.function_call }, state);
  }

  for (const toolDelta of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    applyToolCallDelta(res, toolDelta, state);
  }
}

function ensureTextBlock(res, state) {
  if (state.activeTextIndex !== null) return state.activeTextIndex;

  const index = state.nextIndex++;
  state.activeTextIndex = index;
  writeEvent(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
  return index;
}

function closeTextBlock(res, state) {
  if (state.activeTextIndex === null) return;
  writeEvent(res, "content_block_stop", { type: "content_block_stop", index: state.activeTextIndex });
  state.activeTextIndex = null;
}

function applyToolCallDelta(res, delta, state) {
  closeTextBlock(res, state);

  const openAiIndex = Number.isInteger(delta?.index) ? Number(delta.index) : state.toolStates.size;
  const toolState = ensureToolState(state, openAiIndex);

  if (typeof delta?.id === "string" && delta.id) toolState.id = delta.id;
  if (typeof delta?.function?.name === "string" && delta.function.name) {
    toolState.name = toolState.name ? `${toolState.name}${delta.function.name}` : delta.function.name;
  }

  if (!toolState.started && toolState.name) {
    toolState.started = true;
    toolState.anthropicIndex = state.nextIndex++;
    writeEvent(res, "content_block_start", {
      type: "content_block_start",
      index: toolState.anthropicIndex,
      content_block: { type: "tool_use", id: toolState.id, name: toolState.name, input: {} },
    });
    state.sawTool = true;
    flushPendingToolJson(res, toolState);
  }

  const argsDelta = delta?.function?.arguments;
  if (typeof argsDelta === "string" && argsDelta) {
    toolState.allJson.push(argsDelta);
    if (toolState.started && toolState.anthropicIndex !== null) {
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: toolState.anthropicIndex,
        delta: { type: "input_json_delta", partial_json: argsDelta },
      });
    } else {
      toolState.pendingJson.push(argsDelta);
    }
  }
}

function ensureToolState(state, openAiIndex) {
  let toolState = state.toolStates.get(openAiIndex);
  if (!toolState) {
    toolState = {
      allJson: [],
      anthropicIndex: null,
      id: `toolu_${randomUUID().replaceAll("-", "")}`,
      name: "",
      pendingJson: [],
      started: false,
      stopped: false,
    };
    state.toolStates.set(openAiIndex, toolState);
  }
  return toolState;
}

function flushPendingToolJson(res, toolState) {
  if (!toolState.started || toolState.anthropicIndex === null || !toolState.pendingJson.length) return;
  for (const fragment of toolState.pendingJson) {
    if (!fragment) continue;
    writeEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: toolState.anthropicIndex,
      delta: { type: "input_json_delta", partial_json: fragment },
    });
  }
  toolState.pendingJson = [];
}

function finalizeAnthropicStream(res, state) {
  closeTextBlock(res, state);

  const toolStates = [...state.toolStates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, toolState]) => toolState);

  for (const toolState of toolStates) {
    if (!toolState.started && toolState.name) {
      toolState.started = true;
      toolState.anthropicIndex = state.nextIndex++;
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index: toolState.anthropicIndex,
        content_block: { type: "tool_use", id: toolState.id, name: toolState.name, input: {} },
      });
      state.sawTool = true;
      flushPendingToolJson(res, toolState);
    }

    if (toolState.started && !toolState.stopped && toolState.anthropicIndex !== null) {
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index: toolState.anthropicIndex });
      toolState.stopped = true;
    }
  }

  if (!state.sawContent && !state.sawTool) {
    const index = state.nextIndex++;
    writeEvent(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    writeEvent(res, "content_block_stop", { type: "content_block_stop", index });
  }

  writeEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: state.stopReason || (state.sawTool ? "tool_use" : "end_turn"), stop_sequence: null },
    usage: { output_tokens: state.outputTokens },
  });
  writeEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function createSseParser(onData) {
  let buffer = "";

  const flushEvent = (rawEvent) => {
    const dataLines = [];
    for (const line of rawEvent.replace(/\r/g, "").split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) onData(dataLines.join("\n"));
  };

  return {
    feed(chunk) {
      buffer += chunk;
      while (true) {
        const delimiterMatch = buffer.match(/\r?\n\r?\n/);
        if (!delimiterMatch || delimiterMatch.index === undefined) break;
        const rawEvent = buffer.slice(0, delimiterMatch.index);
        buffer = buffer.slice(delimiterMatch.index + delimiterMatch[0].length);
        if (rawEvent.trim()) flushEvent(rawEvent);
      }
    },
    finish() {
      if (buffer.trim()) flushEvent(buffer);
      buffer = "";
    },
  };
}

async function launchClaude(body = {}) {
  const args = Array.isArray(body.args) && body.args.length ? body.args : ["--model", "claude-sonnet-4-6"];
  const command = buildLaunchCommand(args);

  if (process.platform === "darwin") {
    const osa = spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], {
      detached: true,
      stdio: "ignore",
    });
    osa.unref();
    return { ok: true, platform: process.platform, command };
  }

  if (process.platform === "win32") {
    const child = spawn("powershell.exe", ["-NoExit", "-Command", command], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, platform: process.platform, command };
  }

  return { ok: false, platform: process.platform, command, message: "Launch automatico disponible en macOS y Windows." };
}

function buildLaunchCommand(args) {
  const base = `http://${host}:${port}`;
  if (process.platform === "win32") {
    return [
      `$env:OPENCODE_PROXY_BASE_URL='${base}'`,
      `cd '${rootDir.replaceAll("'", "''")}'`,
      `./scripts/claude-opencode-go.ps1 ${args.map(psQuote).join(" ")}`,
    ].join("; ");
  }
  return [
    `cd ${shellQuote(rootDir)}`,
    `OPENCODE_PROXY_BASE_URL=${shellQuote(base)} ./scripts/claude-opencode-go.sh ${args.map(shellQuote).join(" ")}`,
  ].join("; ");
}

async function serveStatic(requestPath, res) {
  const normalizedPath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const filePath = path.resolve(publicDir, "." + normalizedPath);

  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(body);
  } catch {
    const index = await fs.readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(index);
  }
}

function resolveModel(model) {
  if (config.forceModel) return config.forceModelValue || config.model;
  if (!model) return config.model;
  const lower = String(model).toLowerCase();
  return modelMap()[model] || modelMap()[lower] || config.model;
}

function effectiveModel() {
  return config.forceModel ? config.forceModelValue || config.model : config.model;
}

function modelMap() {
  return {
    sonnet: config.model,
    opus: config.model,
    haiku: config.fastModel,
    "claude-sonnet-4-6": config.model,
    "claude-sonnet-4-5": config.model,
    "claude-sonnet-4": config.model,
    "claude-opus-4-7": config.model,
    "claude-opus-4-6": config.model,
    "claude-haiku-4-5": config.fastModel,
    ...parseJson(config.modelMapJson, {}),
  };
}

function blocksToText(blocks) {
  return blocks.map((block) => {
    if (block.type === "text") return block.text || "";
    if (block.type === "image") return "[image omitted: upstream model may not support image input]";
    if (block.type === "tool_result") return stringifyToolResult(block.content);
    return block.text || JSON.stringify(block);
  }).filter(Boolean).join("\n");
}

function stringifyToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return blocksToText(content);
  return JSON.stringify(content ?? "");
}

function formatOpenAIToolResult(block) {
  const content = stringifyToolResult(block?.content);
  if (!block?.is_error) return content;
  return content ? `Tool execution failed.\n${content}` : "Tool execution failed.";
}

function mapStopReason(reason) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return "end_turn";
}

function shouldFallbackToSyntheticStream(error) {
  const status = Number(error?.status || 0);
  if ([400, 404, 415, 422, 501].includes(status)) return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("provider returned error") || message.includes("unsupported");
}

function shouldUseSyntheticStream(body) {
  return Array.isArray(body?.tools) && body.tools.length > 0;
}

function shouldRetryNarratedToolTurn(original, openai) {
  if (!Array.isArray(original?.tools) || original.tools.length === 0) return false;

  const message = openai?.choices?.[0]?.message || {};
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return false;
  if (message.function_call) return false;

  const lastUserMessage = [...(original?.messages || [])].reverse().find((item) => item?.role === "user");
  const lastUserContent = Array.isArray(lastUserMessage?.content) ? lastUserMessage.content : [];
  const hasRecentToolResult = lastUserContent.some((block) => block?.type === "tool_result");
  if (!hasRecentToolResult) return false;

  const text = openAIContentToText(message.content).trim();
  if (!text) return false;

  return looksLikeNarratedNextAction(text);
}

function looksLikeNarratedNextAction(text) {
  const lower = String(text).toLowerCase().trim();
  if (!lower) return false;
  if (/<\/[a-z_][\w:-]*>\s*$/i.test(lower)) return true;

  const prefixes = [
    "let me ",
    "i need to ",
    "i'll ",
    "i will ",
    "i'm going to ",
    "now i ",
    "first i need to ",
    "déjame ",
    "voy a ",
    "necesito ",
    "ahora ",
    "primero necesito ",
    "tengo que ",
  ];
  const actions = [
    "check",
    "review",
    "inspect",
    "read",
    "open",
    "edit",
    "update",
    "install",
    "look at",
    "revisar",
    "leer",
    "abrir",
    "editar",
    "actualizar",
    "instalar",
    "mirar",
    "comprobar",
  ];

  return prefixes.some((prefix) => lower.startsWith(prefix))
    && actions.some((action) => lower.includes(action));
}

function createProxyLogger(targetPath, source) {
  return {
    path: targetPath,
    log(stage, payload = {}) {
      try {
        ensureLogFile(targetPath);
        rotateLogFile(targetPath);
        appendFileSync(targetPath, `${JSON.stringify({
          ts: new Date().toISOString(),
          source,
          stage,
          ...sanitizeForLog(payload),
        })}\n`, "utf8");
      } catch (error) {
        console.error("JaviProxy log write failed:", error);
      }
    },
  };
}

function createLogContext(loggerInstance, requestId, method, requestPath) {
  const startedAt = Date.now();
  let sequence = 0;
  let chunkIndex = 0;

  return {
    requestId,
    nextChunkIndex() {
      return chunkIndex++;
    },
    log(stage, payload = {}) {
      loggerInstance.log(stage, {
        requestId,
        sequence: sequence++,
        elapsed_ms: Date.now() - startedAt,
        method,
        path: requestPath,
        ...payload,
      });
    },
  };
}

function ensureLogFile(targetPath) {
  const dir = path.dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function rotateLogFile(targetPath, maxBytes = 5_000_000) {
  if (!existsSync(targetPath)) return;
  try {
    if (statSync(targetPath).size < maxBytes) return;
    const rotated = `${targetPath}.1`;
    if (existsSync(rotated)) renameSync(rotated, `${targetPath}.2`);
    renameSync(targetPath, rotated);
  } catch {
    // Best effort only.
  }
}

function summarizeAnthropicRequest(body) {
  return {
    model: body?.model || null,
    stream: Boolean(body?.stream),
    max_tokens: body?.max_tokens ?? null,
    message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
    tool_count: Array.isArray(body?.tools) ? body.tools.length : 0,
    tool_names: Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.name).filter(Boolean) : [],
    system_present: Boolean(body?.system),
    tool_choice: body?.tool_choice || null,
  };
}

function summarizeOpenAIRequest(body) {
  return {
    model: body?.model || null,
    stream: Boolean(body?.stream),
    max_tokens: body?.max_tokens ?? null,
    message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
    roles: Array.isArray(body?.messages) ? body.messages.map((message) => message?.role || "unknown") : [],
    tool_count: Array.isArray(body?.tools) ? body.tools.length : 0,
    tool_names: Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.function?.name || tool?.name).filter(Boolean) : [],
  };
}

function summarizeAnthropicResponse(body) {
  return {
    model: body?.model || null,
    stop_reason: body?.stop_reason || null,
    content_types: Array.isArray(body?.content) ? body.content.map((block) => block?.type || "unknown") : [],
    usage: body?.usage || null,
  };
}

function summarizeAnthropicStreamState(state) {
  return {
    stop_reason: state.stopReason || (state.sawTool ? "tool_use" : "end_turn"),
    sawContent: state.sawContent,
    sawTool: state.sawTool,
    output_tokens: state.outputTokens,
    text: state.emittedText.join(""),
    tools: [...state.toolStates.values()].map((toolState) => ({
      id: toolState.id,
      name: toolState.name,
      input_json: (toolState.allJson || []).join(""),
    })),
  };
}

function sanitizeForLog(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateLogString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    if (depth >= 5) return `[Array(${value.length})]`;
    const items = value.slice(0, 25).map((item) => sanitizeForLog(item, depth + 1, seen));
    if (value.length > 25) items.push(`[+${value.length - 25} more items]`);
    return items;
  }
  if (value instanceof Uint8Array) return `[Uint8Array length=${value.length}]`;
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (depth >= 6) return `[Object keys=${Object.keys(value).length}]`;

    const entries = Object.entries(value);
    const result = {};
    for (const [index, entry] of entries.entries()) {
      if (index >= 40) {
        result.__truncated_keys = entries.length - index;
        break;
      }
      const [key, entryValue] = entry;
      result[key] = isSecretKey(key) ? "[REDACTED]" : sanitizeForLog(entryValue, depth + 1, seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function isSecretKey(key) {
  const normalized = String(key).toLowerCase();
  return normalized === "authorization"
    || normalized === "x-api-key"
    || normalized === "api_key"
    || normalized === "apikey"
    || normalized === "api-key"
    || normalized.endsWith("_token")
    || normalized.endsWith("-token")
    || normalized === "token"
    || normalized.endsWith("_password")
    || normalized.endsWith("-password")
    || normalized === "password"
    || normalized.endsWith("_secret")
    || normalized.endsWith("-secret")
    || normalized === "secret";
}

function truncateLogString(value, maxLength = 4000) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}… [truncated ${value.length - maxLength} chars]`;
}

function parseTaggedToolBlocks(rawText) {
  const text = String(rawText || "");
  const blocks = [];
  const toolUseRegex = /<(tool_use|invoke)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let lastIndex = 0;
  let match;

  while ((match = toolUseRegex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) blocks.push({ type: "text", text: before });

    const attrs = parseXmlAttributes(match[2] || "");
    const name = attrs.name || attrs.tool || attrs.tool_name;
    if (!name) {
      blocks.push({ type: "text", text: match[0] });
    } else {
      blocks.push({
        type: "tool_use",
        id: attrs.id || `toolu_${randomUUID().replaceAll("-", "")}`,
        name,
        input: parseToolInput(match[3] || ""),
      });
    }

    lastIndex = match.index + match[0].length;
  }

  const rest = text.slice(lastIndex);
  const trailing = parseTrailingLooseTaggedToolUse(rest);
  if (trailing) {
    if (trailing.before.trim()) blocks.push({ type: "text", text: trailing.before.trimEnd() });
    blocks.push(trailing.tool);
  } else if (rest || !blocks.length) {
    blocks.push({ type: "text", text: rest || text });
  }
  return blocks.filter((block) => block.type !== "text" || block.text);
}

function parseXmlAttributes(input) {
  const attrs = {};
  const attrRegex = /([a-zA-Z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = attrRegex.exec(input)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function parseToolInput(input) {
  const cleaned = String(input || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = parseJson(cleaned, null);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  return { input: cleaned };
}

function parseTrailingLooseTaggedToolUse(text) {
  const match = String(text || "").match(/<(tool_use|invoke)\b/i);
  if (!match || match.index === undefined || match.index <= 0) return null;

  const before = text.slice(0, match.index);
  const candidate = text.slice(match.index);
  const parsed = candidate.match(/^<(tool_use|invoke)\b([^>]*)>([\s\S]*)$/i);
  if (!parsed) return null;

  const attrs = parseXmlAttributes(parsed[2] || "");
  const name = attrs.name || attrs.tool || attrs.tool_name;
  if (!name) return null;

  return {
    before,
    tool: {
      type: "tool_use",
      id: attrs.id || `toolu_${randomUUID().replaceAll("-", "")}`,
      name,
      input: parseToolInput(parsed[3] || ""),
    },
  };
}

function upstreamHeaders(hasBody) {
  return {
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function anthropicError(type, message) {
  return { type: "error", error: { type, message } };
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function trimRight(value, char) {
  let output = value;
  while (output.endsWith(char)) output = output.slice(0, -1);
  return output;
}

function normalizeGoBaseURL(value) {
  const normalized = trimRight(value, "/");
  return normalized === "https://opencode.ai/zen/v1" ? "https://opencode.ai/zen/go/v1" : normalized;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return "********";
  return `${key.slice(0, 5)}...${key.slice(-4)}`;
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  return "application/octet-stream";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
