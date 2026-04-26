import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ProxyConfig {
  upstreamBase: string
  apiKey: string
  model: string
  fastModel: string
  forceModel: boolean
  forceModelValue: string
  modelMapJson: string
}

export interface ProxyServerHandle {
  server: http.Server
  host: string
  port: number
  baseUrl: string
  messagesUrl: string
}

export const GO_MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'glm-5',
  'glm-5.1',
  'kimi-k2.5',
  'kimi-k2.6',
  'mimo-v2-omni',
  'mimo-v2-pro',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'minimax-m2.5',
  'minimax-m2.7',
  'qwen3.5-plus',
  'qwen3.6-plus'
]

interface StartProxyOptions {
  host: string
  port: number
  getConfig: () => ProxyConfig
  logPath: string
}

interface KnownTool {
  name: string
  inputSchema?: any
}

interface ParsedToolUse {
  id?: string
  name: string
  input: Record<string, unknown>
}

interface StreamToolState {
  allJson: string[]
  anthropicIndex: number | null
  id: string
  name: string
  pendingJson: string[]
  started: boolean
  stopped: boolean
}

interface AnthropicStreamState {
  activeTextIndex: number | null
  emittedText: string[]
  inputTokens: number
  messageId: string
  nextIndex: number
  outputTokens: number
  sawContent: boolean
  sawTool: boolean
  stopReason: string | null
  toolStates: Map<number, StreamToolState>
}

interface ProxyLogger {
  log: (stage: string, payload?: Record<string, unknown>) => void
  path: string
}

interface ProxyLogContext {
  log: (stage: string, payload?: Record<string, unknown>) => void
  nextChunkIndex: () => number
  requestId: string
}

const TOOL_BRIDGE_SYSTEM_PROMPT = [
  'You are connected to Claude Code through JaviProxy.',
  'Use the native OpenAI tool_calls/function-calling channel whenever you need a tool.',
  'When tools are available and the next step requires file inspection, editing, or commands, call the tool immediately instead of narrating intent.',
  'Do not write <tool_use>, <tool_result>, JSON tool envelopes, or bare tool names as normal assistant text.',
  'Historical <tool_use> and <tool_result> tags in the transcript are summaries of already executed tools; do not copy that format.',
  'CRITICAL: When you decide to use a tool, you MUST emit it through the tool_calls channel. Never write the tool name followed by JSON arguments inside the regular text content.',
  'Example of what NOT to do:  Bash{"command": "ls"}  or  Read{"file_path": "x"}',
  'Instead, use the formal tool_calls mechanism provided by the API.'
].join('\n')

const TOOL_CALL_REASONING_REPLAY = 'Bridge replay: original reasoning unavailable.'
const MISSING_TOOL_CALL_RETRY_PROMPT = [
  'Your previous reply described the next action instead of calling a tool.',
  'If the task is not complete and tools are available, do not narrate the next step.',
  'Call the next tool immediately.',
  'Only reply with normal assistant text if the task is complete or you need a blocking clarification from the user.'
].join('\n')

export async function startProxyServer(options: StartProxyOptions): Promise<ProxyServerHandle> {
  const { host, port, getConfig, logPath } = options
  const logger = createProxyLogger(logPath, 'electron')

  const server = http.createServer(async (req, res) => {
    let logContext: ProxyLogContext | null = null
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

      if (req.method === 'OPTIONS') {
        sendCorsPreflight(res)
        return
      }

      if (req.method === 'HEAD') {
        res.writeHead(200, corsHeaders()).end()
        return
      }

      if (req.method === 'GET' && ['/', '/health', '/v1/health'].includes(url.pathname)) {
        const config = getConfig()
        sendJson(res, 200, {
          ok: true,
          app: 'JaviProxy',
          host,
          port,
          messagesUrl: `http://${host}:${port}/v1/messages`,
          upstreamBase: config.upstreamBase,
          effectiveModel: effectiveModel(config),
          hasApiKey: Boolean(config.apiKey),
          logPath: logger.path
        })
        return
      }

      if (req.method === 'GET' && ['/models', '/v1/models'].includes(url.pathname)) {
        const models = await fetchModels(getConfig())
        sendJson(res, 200, { object: 'list', data: models.models.map((id) => ({ id, object: 'model', owned_by: 'opencode' })) })
        return
      }

      if (req.method === 'POST' && ['/messages/count_tokens', '/v1/messages/count_tokens'].includes(url.pathname)) {
        const body = await readJson(req)
        sendJson(res, 200, countTokens(body))
        return
      }

      if (req.method === 'POST' && ['/messages', '/v1/messages'].includes(url.pathname)) {
        const body = await readJson(req)
        const requestId = `req_${randomUUID().replaceAll('-', '').slice(0, 12)}`
        logContext = createLogContext(logger, requestId, req.method || 'POST', url.pathname)
        res.setHeader('x-javiproxy-request-id', requestId)
        logContext.log('anthropic_request', {
          summary: summarizeAnthropicRequest(body),
          headers: {
            'anthropic-version': req.headers['anthropic-version'],
            'anthropic-beta': req.headers['anthropic-beta'],
            'user-agent': req.headers['user-agent']
          },
          body
        })

        if (body.stream) {
          await sendAnthropicStream(req, res, getConfig(), body, logContext)
        } else {
          const response = await createMessage(getConfig(), body, logContext)
          const anthropic = toAnthropicMessage(response, body)
          logContext.log('anthropic_response', {
            summary: summarizeAnthropicResponse(anthropic),
            body: anthropic,
            delivery: 'json'
          })
          sendJson(res, 200, anthropic)
        }
        return
      }

      sendJson(res, 404, anthropicError('not_found_error', `Unsupported route: ${req.method} ${url.pathname}`))
    } catch (error: any) {
      logContext?.log('error', {
        status: Number(error?.status || 500),
        message: error?.message || String(error)
      })
      const status = Number(error?.status || 500)
      if (res.headersSent) {
        if (!res.writableEnded) {
          writeEvent(res, 'error', anthropicError('api_error', error?.message || String(error)))
          res.end()
        }
        return
      }
      sendJson(res, status, anthropicError('api_error', error?.message || String(error)))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  return {
    server,
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    messagesUrl: `http://${host}:${port}/v1/messages`
  }
}

export async function fetchModels(config: ProxyConfig): Promise<{ ok: boolean; models: string[]; raw: any }> {
  // 1. Try the standard OpenAI /models endpoint (in case upstream adds it)
  try {
    const response = await fetch(`${config.upstreamBase}/models`, {
      headers: upstreamHeaders(config, false)
    })
    const contentType = response.headers.get('content-type') || ''
    if (response.ok && contentType.includes('application/json')) {
      const json = await response.json()
      const models = Array.isArray((json as any)?.data)
        ? (json as any).data.map((m: any) => String(m.id)).sort()
        : []
      if (models.length) return { ok: true, models, raw: json }
    }
  } catch { /* fall through to scrape */ }

  // 2. Scrape the OpenCode Go page for the model list
  try {
    const scraped = await scrapeGoModels()
    if (scraped.length) return { ok: true, models: scraped, raw: { source: 'scrape', models: scraped } }
  } catch { /* fall through to hardcoded */ }

  // 3. Hardcoded fallback (kept in sync manually as last resort)
  return { ok: true, models: [...GO_MODEL_IDS], raw: { fallback: true } }
}

/** Scrape https://opencode.ai/go and extract model IDs from the "Includes ..." text. */
async function scrapeGoModels(): Promise<string[]> {
  const response = await fetch('https://opencode.ai/go', {
    headers: { accept: 'text/html', 'user-agent': 'JaviProxy/1.0' }
  })
  if (!response.ok) return []
  const html = await response.text()

  // The page contains a line like: "Includes GLM-5.1, GLM-5, Kimi K2.5, ... and DeepSeek V4 Flash"
  const match = html.match(/Includes\s+([\w\s.,\-]+(?:and\s+[\w\s.\-]+)?)/i)
  if (!match) return []

  return match[1]
    .replace(/\band\b/g, ',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(displayNameToModelId)
    .filter(Boolean)
    .sort()
}

/** Convert a display name like "DeepSeek V4 Pro" to an API model ID like "deepseek-v4-pro". */
function displayNameToModelId(name: string): string {
  return name
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/^mimo-v2-5/, 'mimo-v2.5')   // MiMo-V2.5 variants use dots
    .replace(/^glm-5-1$/, 'glm-5.1')
    .replace(/^qwen3-6/, 'qwen3.6')
    .replace(/^qwen3-5/, 'qwen3.5')
    .replace(/^minimax-m2-7$/, 'minimax-m2.7')
    .replace(/^minimax-m2-5$/, 'minimax-m2.5')
    .replace(/^kimi-k2-6$/, 'kimi-k2.6')
    .replace(/^kimi-k2-5$/, 'kimi-k2.5')
}

export async function testUpstream(config: ProxyConfig): Promise<{ ok: boolean; model: string; message: string; usage: any }> {
  if (!config.apiKey) {
    const error = new Error('Agrega tu API key de OpenCode Go antes de probar.')
    ;(error as any).status = 400
    throw error
  }

  const model = effectiveModel(config)
  const response = await fetch(`${config.upstreamBase}/chat/completions`, {
    method: 'POST',
    headers: upstreamHeaders(config, true),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Responde solo: JaviProxy OK' }],
      max_tokens: 32,
      stream: false
    })
  })

  const json = await readResponseJson(response)
  if (!response.ok) throw upstreamError(response.status, json)

  return {
    ok: true,
    model,
    message: json?.choices?.[0]?.message?.content || '',
    usage: json?.usage || null
  }
}

async function createMessage(config: ProxyConfig, body: any, logContext?: ProxyLogContext): Promise<any> {
  if (!config.apiKey) {
    const error = new Error('Missing OpenCode Go API key. Open JaviProxy and save your API key.')
    ;(error as any).status = 401
    throw error
  }

  const request = toOpenAIChatCompletion(config, body, false)
  logContext?.log('openai_request', {
    summary: summarizeOpenAIRequest(request),
    body: request,
    delivery: 'sync'
  })
  let response = await fetch(`${config.upstreamBase}/chat/completions`, {
    method: 'POST',
    headers: upstreamHeaders(config, true),
    body: JSON.stringify(request)
  })

  let json = await readResponseJson(response)
  logContext?.log('upstream_response', {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    body: json
  })
  if (!response.ok) throw upstreamError(response.status, json)

  if (shouldRetryNarratedToolTurn(body, json)) {
    const retryBody = withExtraSystem(body, MISSING_TOOL_CALL_RETRY_PROMPT)
    const retryRequest = toOpenAIChatCompletion(config, retryBody, false)
    logContext?.log('tool_retry', {
      reason: 'missing_tool_call',
      assistant_text: openAIContentToText(json?.choices?.[0]?.message?.content),
      request_summary: summarizeOpenAIRequest(retryRequest)
    })
    logContext?.log('openai_request_retry', {
      summary: summarizeOpenAIRequest(retryRequest),
      body: retryRequest,
      delivery: 'sync_retry'
    })

    response = await fetch(`${config.upstreamBase}/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders(config, true),
      body: JSON.stringify(retryRequest)
    })
    json = await readResponseJson(response)
    logContext?.log('upstream_response_retry', {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body: json
    })
    if (!response.ok) throw upstreamError(response.status, json)
  }

  return json
}

async function createStreamResponse(config: ProxyConfig, body: any, signal: AbortSignal, logContext?: ProxyLogContext): Promise<Response> {
  if (!config.apiKey) {
    const error = new Error('Missing OpenCode Go API key. Open JaviProxy and save your API key.')
    ;(error as any).status = 401
    throw error
  }

  const request = toOpenAIChatCompletion(config, body, true)
  logContext?.log('openai_request', {
    summary: summarizeOpenAIRequest(request),
    body: request,
    delivery: 'stream'
  })
  const response = await fetch(`${config.upstreamBase}/chat/completions`, {
    method: 'POST',
    headers: { ...upstreamHeaders(config, true), accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal
  })

  if (!response.ok) {
    const json = await readResponseJson(response)
    logContext?.log('upstream_response', {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body: json
    })
    throw upstreamError(response.status, json)
  }

  logContext?.log('upstream_stream_open', {
    status: response.status,
    contentType: response.headers.get('content-type') || ''
  })

  return response
}

function toOpenAIChatCompletion(config: ProxyConfig, body: any, stream: boolean): any {
  const messages: any[] = [
    {
      role: 'system',
      content: TOOL_BRIDGE_SYSTEM_PROMPT
    }
  ]

  if (body.system) {
    messages.push({
      role: 'system',
      content: blocksToText(Array.isArray(body.system) ? body.system : [{ type: 'text', text: String(body.system) }])
    })
  }

  const toolChoiceInstruction = toolChoiceToInstruction(body.tool_choice)
  if (toolChoiceInstruction) {
    messages.push({
      role: 'system',
      content: toolChoiceInstruction
    })
  }

  for (const message of body.messages || []) {
    messages.push(...convertAnthropicMessage(message))
  }

  const request: any = {
    model: resolveModel(config, body.model),
    messages,
    stream
  }

  if (body.max_tokens) request.max_tokens = Math.max(Number(body.max_tokens) || 0, 128)
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  if (typeof body.top_p === 'number') request.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) request.stop = body.stop_sequences

  const tools = convertTools(body.tools)
  if (tools.length) {
    request.tools = tools
    const parallelToolCalls = extractParallelToolCalls(body.tool_choice)
    if (typeof parallelToolCalls === 'boolean') {
      request.parallel_tool_calls = parallelToolCalls
    }
  }

  return request
}

function withExtraSystem(body: any, extraSystem: string): any {
  const existingSystem = Array.isArray(body?.system)
    ? body.system
    : body?.system
      ? [{ type: 'text', text: String(body.system) }]
      : []

  return {
    ...body,
    system: [
      ...existingSystem,
      { type: 'text', text: extraSystem }
    ]
  }
}

function convertAnthropicMessage(message: any): any[] {
  const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }]

  if (message.role === 'assistant') {
    const text = blocksToText(content.filter((block) => block.type === 'text'))
    const toolCalls = content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id || `toolu_${randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        }
      }))

    return [{
      role: 'assistant',
      content: text || (toolCalls.length ? '' : null),
      ...(toolCalls.length ? { reasoning_content: TOOL_CALL_REASONING_REPLAY } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    }]
  }

  const result: any[] = []
  const userText: any[] = []

  for (const block of content) {
    if (block.type === 'tool_result') {
      result.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: formatOpenAIToolResult(block)
      })
    } else {
      userText.push(block)
    }
  }

  if (userText.length) {
    result.push({ role: 'user', content: blocksToText(userText) })
  }

  return result.length ? result : [{ role: 'user', content: '' }]
}

function convertTools(tools: any[] = []): any[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }))
}

function toolChoiceToInstruction(choice: any): string | undefined {
  if (!choice) return undefined
  if (choice.type === 'none') return 'For this turn, do not call any tools. Reply with normal assistant text.'
  if (choice.type === 'any') return 'For this turn, you must call exactly one available tool using the native tool_calls/function-calling channel.'
  if (choice.type === 'tool' && choice.name) {
    return `For this turn, you must call the ${choice.name} tool using the native tool_calls/function-calling channel.`
  }
  return undefined
}

/**
 * Extract OpenAI's `parallel_tool_calls` flag from Anthropic's `tool_choice`.
 *
 * Anthropic uses `disable_parallel_tool_use` (inverse logic) inside
 * `tool_choice`. OpenAI uses `parallel_tool_calls` at the request level.
 *
 * Mappings:
 *   disable_parallel_tool_use: true  -> parallel_tool_calls: false
 *   disable_parallel_tool_use: false -> parallel_tool_calls: true
 *   type: "any"                       -> parallel_tool_calls: true
 *   type: "tool"                      -> parallel_tool_calls: false
 *   type: "auto" | "none"             -> undefined (leave to upstream default)
 */
function extractParallelToolCalls(toolChoice: any): boolean | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined

  // Explicit disable_parallel_tool_use takes precedence
  if (toolChoice.disable_parallel_tool_use === true) return false
  if (toolChoice.disable_parallel_tool_use === false) return true

  // Fallback to type heuristics when the flag is absent
  if (toolChoice.type === 'any') return true
  if (toolChoice.type === 'tool') return false

  return undefined
}

function toAnthropicMessage(openai: any, original: any): any {
  const choice = openai?.choices?.[0] || {}
  const message = choice.message || {}
  const content: any[] = []
  const knownTools = knownToolsFromRequest(original)

  if (message.content) content.push(...parseTextAndToolUses(openAIContentToText(message.content), knownTools))

  for (const call of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: call.id || `toolu_${randomUUID().replaceAll('-', '')}`,
      name: call.function?.name || 'tool',
      input: parseJson(call.function?.arguments || '{}', {})
    })
  }

  if (message.function_call) {
    content.push({
      type: 'tool_use',
      id: `toolu_${randomUUID().replaceAll('-', '')}`,
      name: message.function_call.name || 'tool',
      input: parseJson(message.function_call.arguments || '{}', {})
    })
  }

  if (!content.length) content.push({ type: 'text', text: '' })

  return {
    id: openai.id || `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: original.model || 'opencode-go',
    content,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openai?.usage?.prompt_tokens || 0,
      output_tokens: openai?.usage?.completion_tokens || 0
    }
  }
}

async function sendAnthropicStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ProxyConfig,
  original: any,
  logContext: ProxyLogContext
): Promise<void> {
  if (shouldUseSyntheticStream(original, config)) {
    logContext.log('stream_strategy', { mode: 'synthetic_tool_turn' })
    const json = await createMessage(config, original, logContext)
    const anthropic = toAnthropicMessage(json, original)
    logContext.log('anthropic_response', {
      summary: summarizeAnthropicResponse(anthropic),
      body: anthropic,
      delivery: 'synthetic_stream'
    })
    sendAnthropicMessageAsStream(res, anthropic)
    return
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  const state: AnthropicStreamState = {
    activeTextIndex: null,
    emittedText: [],
    inputTokens: 0,
    messageId: `msg_${randomUUID().replaceAll('-', '')}`,
    nextIndex: 0,
    outputTokens: 0,
    sawContent: false,
    sawTool: false,
    stopReason: null,
    toolStates: new Map()
  }
  let heartbeat: NodeJS.Timeout | null = null
  let started = false

  req.once('close', abort)
  res.once('close', abort)

  try {
    let upstream: Response
    try {
      upstream = await createStreamResponse(config, original, controller.signal, logContext)
      logContext.log('stream_strategy', { mode: 'native_upstream_sse' })
    } catch (error: any) {
      if (!shouldFallbackToSyntheticStream(error)) throw error
      logContext.log('stream_strategy', {
        mode: 'fallback_to_synthetic',
        reason: error?.message || String(error)
      })
      const json = await createMessage(config, original, logContext)
      const anthropic = toAnthropicMessage(json, original)
      logContext.log('anthropic_response', {
        summary: summarizeAnthropicResponse(anthropic),
        body: anthropic,
        delivery: 'synthetic_stream_after_error'
      })
      sendAnthropicMessageAsStream(res, anthropic)
      return
    }
    const contentType = upstream.headers.get('content-type') || ''

    if (!contentType.includes('text/event-stream') || !upstream.body) {
      const json = await readResponseJson(upstream)
      const anthropic = toAnthropicMessage(json, original)
      logContext.log('stream_strategy', {
        mode: 'fallback_to_synthetic_non_sse',
        contentType
      })
      logContext.log('upstream_response', {
        status: upstream.status,
        contentType,
        body: json
      })
      logContext.log('anthropic_response', {
        summary: summarizeAnthropicResponse(anthropic),
        body: anthropic,
        delivery: 'synthetic_stream_non_sse'
      })
      sendAnthropicMessageAsStream(res, anthropic)
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...corsHeaders()
    })
    started = true

    writeEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: original.model || 'opencode-go',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })

    heartbeat = setInterval(() => {
      if (!res.writableEnded) writeEvent(res, 'ping', { type: 'ping' })
    }, 10_000)

    const parser = createSseParser((data) => {
      if (!data || data === '[DONE]') return
      const chunk = parseJson(data, null)
      if (!chunk) return
      if (chunk?.error?.message) throw upstreamError(502, chunk)
      logContext.log('upstream_stream_chunk', {
        index: logContext.nextChunkIndex(),
        chunk
      })
      applyOpenAIStreamChunk(res, chunk, state)
    })

    const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parser.feed(value)
    }
    parser.finish()

    finalizeAnthropicStream(res, state)
    logContext.log('anthropic_stream_summary', summarizeAnthropicStreamState(state))
  } catch (error: any) {
    if (controller.signal.aborted) {
      logContext.log('stream_aborted', { reason: 'client_disconnected' })
      if (started && !res.writableEnded) res.end()
      return
    }
    if (!started) throw error
    if (!res.writableEnded) {
      logContext.log('stream_error', { message: error?.message || String(error) })
      writeEvent(res, 'error', anthropicError('api_error', error?.message || String(error)))
      res.end()
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    req.off('close', abort)
    res.off('close', abort)
  }
}

function sendAnthropicMessageAsStream(res: http.ServerResponse, message: any): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...corsHeaders()
  })

  writeEvent(res, 'message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } }
  })

  message.content.forEach((block: any, index: number) => {
    if (block.type === 'tool_use') {
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
      })
      writeEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) }
      })
      writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
      return
    }

    writeEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' }
    })
    if (block.text) {
      writeEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text }
      })
    }
    writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
  })

  writeEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens }
  })
  writeEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

export function effectiveModel(config: ProxyConfig): string {
  return config.forceModel ? config.forceModelValue || config.model : config.model
}

function countTokens(body: any): { input_tokens: number } {
  const text = [
    typeof body.system === 'string' ? body.system : blocksToText(Array.isArray(body.system) ? body.system : []),
    ...(body.messages || []).map((message: any) => blocksToText(Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }])),
    ...(body.tools || []).map((tool: any) => `${tool.name || ''}\n${tool.description || ''}\n${JSON.stringify(tool.input_schema || {})}`)
  ].filter(Boolean).join('\n')

  return { input_tokens: Math.max(1, Math.ceil(text.length / 4)) }
}

function resolveModel(config: ProxyConfig, model: string): string {
  if (config.forceModel) return config.forceModelValue || config.model
  if (!model) return config.model
  const map = modelMap(config)
  return map[model] || map[String(model).toLowerCase()] || config.model
}

function modelMap(config: ProxyConfig): Record<string, string> {
  return {
    sonnet: config.model,
    opus: config.model,
    haiku: config.fastModel,
    'claude-sonnet-4-6': config.model,
    'claude-sonnet-4-5': config.model,
    'claude-sonnet-4': config.model,
    'claude-opus-4-7': config.model,
    'claude-opus-4-6': config.model,
    'claude-haiku-4-5': config.fastModel,
    ...parseJson(config.modelMapJson, {})
  }
}

function blocksToText(blocks: any[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text || ''
    if (block.type === 'image') return '[image omitted: upstream model may not support image input]'
    if (block.type === 'tool_result') return stringifyToolResult(block.content)
    return block.text || JSON.stringify(block)
  }).filter(Boolean).join('\n')
}

function openAIContentToText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text') return part.text || ''
      if (typeof part?.text === 'string') return part.text
      return ''
    }).filter(Boolean).join('\n')
  }
  return String(content ?? '')
}

function applyOpenAIStreamChunk(res: http.ServerResponse, chunk: any, state: AnthropicStreamState): void {
  const usage = chunk?.usage || {}
  if (typeof usage.prompt_tokens === 'number') state.inputTokens = usage.prompt_tokens
  if (typeof usage.completion_tokens === 'number') state.outputTokens = usage.completion_tokens

  const choice = chunk?.choices?.[0] || {}
  if (choice.finish_reason) state.stopReason = mapStopReason(choice.finish_reason)

  const delta = choice.delta || {}
  const text = openAIContentToText(delta.content)
  if (text) {
    state.emittedText.push(text)
    const index = ensureTextBlock(res, state)
    writeEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text }
    })
    state.sawContent = true
  }

  if (delta.function_call) {
    applyToolCallDelta(res, { index: 0, function: delta.function_call }, state)
  }

  for (const toolDelta of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    applyToolCallDelta(res, toolDelta, state)
  }
}

function ensureTextBlock(res: http.ServerResponse, state: AnthropicStreamState): number {
  if (state.activeTextIndex !== null) return state.activeTextIndex

  const index = state.nextIndex++
  state.activeTextIndex = index
  writeEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' }
  })
  return index
}

function closeTextBlock(res: http.ServerResponse, state: AnthropicStreamState): void {
  if (state.activeTextIndex === null) return
  writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: state.activeTextIndex })
  state.activeTextIndex = null
}

function applyToolCallDelta(res: http.ServerResponse, delta: any, state: AnthropicStreamState): void {
  closeTextBlock(res, state)

  const openAiIndex = Number.isInteger(delta?.index) ? Number(delta.index) : state.toolStates.size
  const toolState = ensureToolState(state, openAiIndex)

  if (typeof delta?.id === 'string' && delta.id) toolState.id = delta.id
  if (typeof delta?.function?.name === 'string' && delta.function.name) {
    toolState.name = toolState.name ? `${toolState.name}${delta.function.name}` : delta.function.name
  }

  if (!toolState.started && toolState.name) {
    toolState.started = true
    toolState.anthropicIndex = state.nextIndex++
    writeEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: toolState.anthropicIndex,
      content_block: { type: 'tool_use', id: toolState.id, name: toolState.name, input: {} }
    })
    state.sawTool = true
    flushPendingToolJson(res, toolState)
  }

  const argsDelta = delta?.function?.arguments
  if (typeof argsDelta === 'string' && argsDelta) {
    toolState.allJson.push(argsDelta)
    if (toolState.started && toolState.anthropicIndex !== null) {
      writeEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: toolState.anthropicIndex,
        delta: { type: 'input_json_delta', partial_json: argsDelta }
      })
    } else {
      toolState.pendingJson.push(argsDelta)
    }
  }
}

function ensureToolState(state: AnthropicStreamState, openAiIndex: number): StreamToolState {
  let toolState = state.toolStates.get(openAiIndex)
  if (!toolState) {
    toolState = {
      allJson: [],
      anthropicIndex: null,
      id: `toolu_${randomUUID().replaceAll('-', '')}`,
      name: '',
      pendingJson: [],
      started: false,
      stopped: false
    }
    state.toolStates.set(openAiIndex, toolState)
  }
  return toolState
}

function flushPendingToolJson(res: http.ServerResponse, toolState: StreamToolState): void {
  if (!toolState.started || toolState.anthropicIndex === null || !toolState.pendingJson.length) return
  for (const fragment of toolState.pendingJson) {
    if (!fragment) continue
    writeEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: toolState.anthropicIndex,
      delta: { type: 'input_json_delta', partial_json: fragment }
    })
  }
  toolState.pendingJson = []
}

function finalizeAnthropicStream(res: http.ServerResponse, state: AnthropicStreamState): void {
  closeTextBlock(res, state)

  const toolStates = [...state.toolStates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, toolState]) => toolState)

  for (const toolState of toolStates) {
    if (!toolState.started && toolState.name) {
      toolState.started = true
      toolState.anthropicIndex = state.nextIndex++
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: toolState.anthropicIndex,
        content_block: { type: 'tool_use', id: toolState.id, name: toolState.name, input: {} }
      })
      state.sawTool = true
      flushPendingToolJson(res, toolState)
    }

    if (toolState.started && !toolState.stopped && toolState.anthropicIndex !== null) {
      writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: toolState.anthropicIndex })
      toolState.stopped = true
    }
  }

  if (!state.sawContent && !state.sawTool) {
    const index = state.nextIndex++
    writeEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' }
    })
    writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
  }

  writeEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: state.stopReason || (state.sawTool ? 'tool_use' : 'end_turn'), stop_sequence: null },
    usage: { output_tokens: state.outputTokens }
  })
  writeEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

function createSseParser(onData: (data: string) => void): { feed: (chunk: string) => void; finish: () => void } {
  let buffer = ''

  const flushEvent = (rawEvent: string) => {
    const dataLines: string[] = []
    for (const line of rawEvent.replace(/\r/g, '').split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length) onData(dataLines.join('\n'))
  }

  return {
    feed(chunk: string) {
      buffer += chunk
      while (true) {
        const delimiterMatch = buffer.match(/\r?\n\r?\n/)
        if (!delimiterMatch || delimiterMatch.index === undefined) break
        const rawEvent = buffer.slice(0, delimiterMatch.index)
        buffer = buffer.slice(delimiterMatch.index + delimiterMatch[0].length)
        if (rawEvent.trim()) flushEvent(rawEvent)
      }
    },
    finish() {
      if (buffer.trim()) flushEvent(buffer)
      buffer = ''
    }
  }
}

function knownToolsFromRequest(body: any): KnownTool[] {
  return Array.isArray(body?.tools)
    ? body.tools
      .filter((tool: any) => tool?.name)
      .map((tool: any) => ({ name: String(tool.name), inputSchema: tool.input_schema }))
    : []
}

export function parseTextAndToolUses(rawText: string, knownTools: KnownTool[] = []): any[] {
  const text = decodeHtmlEntities(rawText)
  const blocks: any[] = []
  const toolUseRegex = /<(tool_use|invoke)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  let lastIndex = 0
  let match: RegExpExecArray | null
  let toolIndex = 0

  while ((match = toolUseRegex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index)
    toolIndex += appendTextOrToolBlocks(blocks, before, knownTools, toolIndex)

    const tagName = String(match[1] || '').toLowerCase()
    const attrs = parseAttributes(match[2] || '')
    const parsed = tagName === 'invoke'
      ? parseInvokeToolUse(attrs, match[3] || '')
      : parseXmlToolUse(attrs, match[3] || '')

    if (parsed) {
      blocks.push({
        type: 'tool_use',
        id: parsed.id || `toolu_${parsed.name}_${toolIndex}`,
        name: parsed.name,
        input: parsed.input
      })
      toolIndex += 1
    } else {
      blocks.push({ type: 'text', text: match[0] })
    }
    lastIndex = match.index + match[0].length
  }

  const rest = text.slice(lastIndex)
  appendTextOrToolBlocks(blocks, rest, knownTools, toolIndex)

  return blocks.length ? blocks : [{ type: 'text', text: rawText }]
}

function appendTextOrToolBlocks(blocks: any[], value: string, knownTools: KnownTool[], startIndex: number): number {
  const cleaned = cleanToolFenceText(value)
  if (!cleaned) return 0

  const looseTagged = parseLooseTaggedToolUse(cleaned)
  if (looseTagged) {
    blocks.push({
      type: 'tool_use',
      id: looseTagged.id || `toolu_${looseTagged.name}_${startIndex}`,
      name: looseTagged.name,
      input: looseTagged.input
    })
    return 1
  }

  const parsed = parseJsonToolUses(cleaned, knownTools)
  if (parsed.length) {
    parsed.forEach((tool, offset) => {
      blocks.push({
        type: 'tool_use',
        id: tool.id || `toolu_${tool.name}_${startIndex + offset}`,
        name: tool.name,
        input: tool.input
      })
    })
    return parsed.length
  }

  // Try fused text+tool format first (DeepSeek-V4 etc.) because it preserves surrounding prose
  const split = splitTextAndFusedTools(cleaned, knownTools)
  if (split.length > 1 || (split.length === 1 && split[0].type === 'tool_use')) {
    let offset = 0
    for (const part of split) {
      if (part.type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: `toolu_${part.name}_${startIndex + offset}`,
          name: part.name,
          input: part.input
        })
        offset += 1
      } else if (part.text.trim()) {
        blocks.push({ type: 'text', text: part.text.trimEnd() })
      }
    }
    return offset
  }

  const plain = parsePlainToolLines(cleaned, knownTools)
  if (plain.length) {
    plain.forEach((tool, offset) => {
      blocks.push({
        type: 'tool_use',
        id: tool.id || `toolu_${tool.name}_${startIndex + offset}`,
        name: tool.name,
        input: tool.input
      })
    })
    return plain.length
  }

  const trailing = parseTrailingLooseTaggedToolUse(cleaned)
  if (trailing) {
    if (trailing.before.trim()) {
      blocks.push({ type: 'text', text: trailing.before.trimEnd() })
    }
    blocks.push({
      type: 'tool_use',
      id: trailing.tool.id || `toolu_${trailing.tool.name}_${startIndex}`,
      name: trailing.tool.name,
      input: trailing.tool.input
    })
    return 1
  }

  blocks.push({ type: 'text', text: cleaned })
  return 0
}

/**
 * Split text that contains fused tool calls (e.g. DeepSeek-V4 output) into
 * an ordered list of text and tool_use segments.
 */
function splitTextAndFusedTools(text: string, knownTools: KnownTool[]): Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }> {
  const parts: Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }> = []
  const toolNames = knownTools.map((t) => t.name).sort((a, b) => b.length - a.length)
  const escaped = toolNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!escaped.length) return [{ type: 'text', text }]

  const pattern = new RegExp(`(${escaped.join('|')})(\\{[\\s\\S]*?\\}\\s*(?=\\n|$)|\\[[\\s\\S]*?\\]\\s*(?=\\n|$))`, 'g')
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index)
    if (before) parts.push({ type: 'text', text: before })

    const name = match[1]
    const jsonPart = match[2].trim()
    const input = parseJson(jsonPart, null)
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      parts.push({ type: 'tool_use', name, input })
      lastIndex = pattern.lastIndex
    } else {
      // Not valid JSON, treat as text
      parts.push({ type: 'text', text: match[0] })
      lastIndex = match.index + match[0].length
    }
  }

  const after = text.slice(lastIndex)
  if (after) parts.push({ type: 'text', text: after })

  return parts.length ? parts : [{ type: 'text', text }]
}

function parseLooseTaggedToolUse(text: string): ParsedToolUse | null {
  const match = text.match(/^<(tool_use|invoke)\b([^>]*)>([\s\S]*)$/i)
  if (!match) return null

  const tagName = String(match[1] || '').toLowerCase()
  const attrs = parseAttributes(match[2] || '')
  const body = stripTrailingCodeFence(match[3] || '')
  return tagName === 'invoke'
    ? parseInvokeToolUse(attrs, body)
    : parseXmlToolUse(attrs, body)
}

function parseTrailingLooseTaggedToolUse(text: string): { before: string; tool: ParsedToolUse } | null {
  const match = text.match(/<(tool_use|invoke)\b/i)
  if (!match || match.index === undefined || match.index <= 0) return null

  const before = text.slice(0, match.index)
  const candidate = text.slice(match.index)
  const tool = parseLooseTaggedToolUse(candidate)
  if (!tool) return null

  return { before, tool }
}

function parseXmlToolUse(attrs: Record<string, string>, body: string): ParsedToolUse | null {
  const name = attrs.name || attrs.tool || attrs.tool_name || inferToolName(attrs.id)
  if (!name) return null
  return {
    id: attrs.id,
    name,
    input: parseToolInput(attrs.input || attrs.arguments || attrs.parameters || body)
  }
}

function parseInvokeToolUse(attrs: Record<string, string>, body: string): ParsedToolUse | null {
  const name = attrs.name || attrs.tool || attrs.tool_name || inferToolName(attrs.id)
  if (!name) return null

  const input: Record<string, unknown> = {}
  const parameterRegex = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi
  let match: RegExpExecArray | null
  while ((match = parameterRegex.exec(body)) !== null) {
    const parameterAttrs = parseAttributes(match[1] || '')
    const key = parameterAttrs.name || parameterAttrs.key
    if (key) input[key] = normalizeScalar(match[2] || '')
  }

  return {
    id: attrs.id,
    name,
    input: Object.keys(input).length ? input : parseToolInput(body)
  }
}

function parseJsonToolUses(text: string, knownTools: KnownTool[]): ParsedToolUse[] {
  const candidates = jsonCandidates(text)
  for (const candidate of candidates) {
    const parsed = parseJson(candidate, null)
    const normalized = normalizeJsonToolUse(parsed, knownTools)
    if (normalized.length) return normalized
  }
  return []
}

function jsonCandidates(text: string): string[] {
  const candidates: string[] = []
  const fenceRegex = /```(?:json|tool|tool_use)?\s*([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fenceRegex.exec(text)) !== null) {
    const candidate = match[1]?.trim()
    if (candidate) candidates.push(candidate)
  }

  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    candidates.push(trimmed)
  }

  return candidates
}

function normalizeJsonToolUse(value: any, knownTools: KnownTool[]): ParsedToolUse[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap((item) => normalizeJsonToolUse(item, knownTools))

  if (Array.isArray(value.tool_calls)) return value.tool_calls.flatMap((item: any) => normalizeJsonToolUse(item, knownTools))
  if (value.tool_use) return normalizeJsonToolUse(value.tool_use, knownTools)
  if (value.function_call) return normalizeJsonToolUse(value.function_call, knownTools)

  const functionPayload = value.function || {}
  const name = value.name || value.tool || value.tool_name || functionPayload.name
  if (!name || !isKnownTool(String(name), knownTools)) return []

  const rawInput = value.input ?? value.arguments ?? value.parameters ?? value.args ?? functionPayload.arguments ?? {}
  const input = typeof rawInput === 'string' ? parseToolInput(rawInput) : normalizeObjectInput(rawInput)

  return [{
    id: value.id,
    name: String(name),
    input
  }]
}

function parsePlainToolLines(text: string, knownTools: KnownTool[]): ParsedToolUse[] {
  if (!knownTools.length) return []

  const bashBlock = text.match(/^Bash(?:\s+(.+))?\s*\nIN\s*\n([\s\S]+?)(?:\nOUT\s*\n[\s\S]*)?$/i)
  if (bashBlock && isKnownTool('Bash', knownTools)) {
    return [{
      name: 'Bash',
      input: {
        command: bashBlock[2].trim(),
        ...(bashBlock[1]?.trim() ? { description: bashBlock[1].trim() } : {})
      }
    }]
  }

  // DeepSeek-V4 (and some other models) intermittently emit tool calls as
  // raw text in the content field instead of structured tool_calls:
  //   "some text... functionName{\"key\": \"value\"}"
  // Try to extract any known tool name immediately followed by a JSON object.
  const fused = parseFusedToolJson(text, knownTools)
  if (fused.length) return fused

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length || lines.some((line) => line.length > 500)) return []

  const parsed = lines.map((line) => parsePlainToolLine(line, knownTools))
  return parsed.every(Boolean) ? parsed as ParsedToolUse[] : []
}

/**
 * Handles models (e.g. DeepSeek-V4) that write tool calls fused into prose:
 *   "Let me search. WebSearch{\"query\": \"foo\"}"
 *   "batch_crawl_url_and_answer{\"jobs\": [...]}"
 */
function parseFusedToolJson(text: string, knownTools: KnownTool[]): ParsedToolUse[] {
  const results: ParsedToolUse[] = []
  const toolNames = knownTools.map((t) => t.name).sort((a, b) => b.length - a.length)
  // Build a regex that matches any known tool name followed immediately by a JSON object/array
  const escaped = toolNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!escaped.length) return []

  const pattern = new RegExp(`(${escaped.join('|')})(\\{[\\s\\S]*?\\}\\s*(?=\\n|$)|\\[[\\s\\S]*?\\]\\s*(?=\\n|$))`, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]
    const jsonPart = match[2].trim()
    const input = parseJson(jsonPart, null)
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      results.push({ name, input })
    }
  }

  return results
}

function parsePlainToolLine(line: string, knownTools: KnownTool[]): ParsedToolUse | null {
  const match = line.match(/^([A-Za-z_][\w.-]*)(?:[:(]?\s+|\()(.+?)\)?$/)
  if (!match) return null

  const name = match[1]
  if (!isKnownTool(name, knownTools)) return null

  const arg = unquote(match[2].trim())
  const key = singleArgumentKey(name, knownTools)
  if (!key) return null
  return { name, input: { [key]: arg } }
}

function singleArgumentKey(name: string, knownTools: KnownTool[]): string | null {
  const fixed: Record<string, string> = {
    Read: 'file_path',
    LS: 'path',
    Glob: 'pattern',
    Grep: 'pattern',
    Bash: 'command',
    WebFetch: 'url',
    WebSearch: 'query'
  }
  if (fixed[name]) return fixed[name]

  const tool = knownTools.find((item) => item.name === name)
  const required = Array.isArray(tool?.inputSchema?.required) ? tool?.inputSchema.required : []
  return required.length === 1 ? String(required[0]) : null
}

function isKnownTool(name: string, knownTools: KnownTool[]): boolean {
  return !knownTools.length || knownTools.some((tool) => tool.name === name)
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRegex = /([a-zA-Z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match: RegExpExecArray | null
  while ((match = attrRegex.exec(input)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attrs
}

function cleanToolFenceText(value: string): string {
  const cleaned = value.trim()
  if (!cleaned) return ''
  if (/^```(?:xml|json|tool_use)?$/i.test(cleaned)) return ''
  if (cleaned === '```') return ''
  return cleaned
}

function stripTrailingCodeFence(value: string): string {
  return value.replace(/\s*```$/i, '').trim()
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function inferToolName(id: string | undefined): string {
  if (!id) return ''
  const match = id.match(/^([A-Za-z_][\w-]*)[:_-]/)
  return match?.[1] || ''
}

function parseToolInput(input: string): Record<string, unknown> {
  const cleaned = input
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const parsed = parseJson(cleaned, null)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  return { input: cleaned }
}

function normalizeObjectInput(value: any): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  return { input: value ?? '' }
}

function normalizeScalar(value: string): unknown {
  const cleaned = value.trim()
  const parsed = parseJson(cleaned, null)
  return parsed ?? cleaned
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function stringifyToolResult(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return blocksToText(content)
  return JSON.stringify(content ?? '')
}

function formatOpenAIToolResult(block: any): string {
  const content = stringifyToolResult(block?.content)
  if (!block?.is_error) return content
  return content ? `Tool execution failed.\n${content}` : 'Tool execution failed.'
}

function mapStopReason(reason: string): string {
  if (reason === 'length') return 'max_tokens'
  if (reason === 'tool_calls') return 'tool_use'
  return 'end_turn'
}

function shouldFallbackToSyntheticStream(error: any): boolean {
  const status = Number(error?.status || 0)
  if ([400, 404, 415, 422, 501].includes(status)) return true
  const message = String(error?.message || '').toLowerCase()
  return message.includes('provider returned error') || message.includes('unsupported')
}

function shouldUseSyntheticStream(body: any, config: ProxyConfig): boolean {
  // Default to native SSE streaming for speed. Only force synthetic mode
  // for upstream models known to intermittently emit tool calls as plain
  // text inside the content field (e.g. DeepSeek-V4), because the proxy
  // needs the full response to parse and split fused tool calls correctly.
  const resolvedModel = resolveModel(config, body?.model)
  const lowerModel = resolvedModel.toLowerCase()
  if (lowerModel.includes('deepseek') || lowerModel.includes('qwen')) {
    return Array.isArray(body?.tools) && body.tools.length > 0
  }
  return false
}

function shouldRetryNarratedToolTurn(original: any, openai: any): boolean {
  if (!Array.isArray(original?.tools) || original.tools.length === 0) return false

  const message = openai?.choices?.[0]?.message || {}
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return false
  if (message.function_call) return false

  const lastUserMessage = [...(original?.messages || [])].reverse().find((item: any) => item?.role === 'user')
  const lastUserContent = Array.isArray(lastUserMessage?.content) ? lastUserMessage.content : []
  const hasRecentToolResult = lastUserContent.some((block: any) => block?.type === 'tool_result')
  if (!hasRecentToolResult) return false

  const text = openAIContentToText(message.content).trim()
  if (!text) return false

  return looksLikeNarratedNextAction(text)
}

function looksLikeNarratedNextAction(text: string): boolean {
  const lower = text.toLowerCase().trim()
  if (!lower) return false
  if (/<\/[a-z_][\w:-]*>\s*$/i.test(lower)) return true

  const prefixes = [
    'let me ',
    "i need to ",
    "i'll ",
    'i will ',
    "i'm going to ",
    'now i ',
    'first i need to ',
    'déjame ',
    'voy a ',
    'necesito ',
    'ahora ',
    'primero necesito ',
    'tengo que '
  ]
  const actions = [
    'check',
    'review',
    'inspect',
    'read',
    'open',
    'edit',
    'update',
    'install',
    'look at',
    'revisar',
    'leer',
    'abrir',
    'editar',
    'actualizar',
    'instalar',
    'mirar',
    'comprobar'
  ]

  return prefixes.some((prefix) => lower.startsWith(prefix))
    && actions.some((action) => lower.includes(action))
}

function createProxyLogger(logPath: string, source: 'electron'): ProxyLogger {
  const path = logPath

  return {
    path,
    log(stage: string, payload: Record<string, unknown> = {}) {
      try {
        const sanitized = sanitizeForLog(payload) as Record<string, unknown>
        ensureLogFile(path)
        rotateLogFile(path)
        appendFileSync(path, `${JSON.stringify({
          ts: new Date().toISOString(),
          source,
          stage,
          ...sanitized
        })}\n`, 'utf8')
      } catch (error) {
        console.error('JaviProxy log write failed:', error)
      }
    }
  }
}

function createLogContext(logger: ProxyLogger, requestId: string, method: string, path: string): ProxyLogContext {
  const startedAt = Date.now()
  let sequence = 0
  let chunkIndex = 0

  return {
    requestId,
    nextChunkIndex: () => chunkIndex++,
    log(stage: string, payload: Record<string, unknown> = {}) {
      logger.log(stage, {
        requestId,
        sequence: sequence++,
        elapsed_ms: Date.now() - startedAt,
        method,
        path,
        ...payload
      })
    }
  }
}

function ensureLogFile(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function rotateLogFile(path: string, maxBytes = 5_000_000): void {
  if (!existsSync(path)) return
  try {
    if (statSync(path).size < maxBytes) return
    const rotated = `${path}.1`
    if (existsSync(rotated)) renameSync(rotated, `${path}.2`)
    renameSync(path, rotated)
  } catch {
    // Best effort: if rotation fails, keep logging into the current file.
  }
}

function summarizeAnthropicRequest(body: any): Record<string, unknown> {
  return {
    model: body?.model || null,
    stream: Boolean(body?.stream),
    max_tokens: body?.max_tokens ?? null,
    message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
    tool_count: Array.isArray(body?.tools) ? body.tools.length : 0,
    tool_names: Array.isArray(body?.tools) ? body.tools.map((tool: any) => tool?.name).filter(Boolean) : [],
    system_present: Boolean(body?.system),
    tool_choice: body?.tool_choice || null
  }
}

function summarizeOpenAIRequest(body: any): Record<string, unknown> {
  return {
    model: body?.model || null,
    stream: Boolean(body?.stream),
    max_tokens: body?.max_tokens ?? null,
    message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
    roles: Array.isArray(body?.messages) ? body.messages.map((message: any) => message?.role || 'unknown') : [],
    tool_count: Array.isArray(body?.tools) ? body.tools.length : 0,
    tool_names: Array.isArray(body?.tools) ? body.tools.map((tool: any) => tool?.function?.name || tool?.name).filter(Boolean) : []
  }
}

function summarizeAnthropicResponse(body: any): Record<string, unknown> {
  return {
    model: body?.model || null,
    stop_reason: body?.stop_reason || null,
    content_types: Array.isArray(body?.content) ? body.content.map((block: any) => block?.type || 'unknown') : [],
    usage: body?.usage || null
  }
}

function summarizeAnthropicStreamState(state: AnthropicStreamState): Record<string, unknown> {
  return {
    stop_reason: state.stopReason || (state.sawTool ? 'tool_use' : 'end_turn'),
    sawContent: state.sawContent,
    sawTool: state.sawTool,
    output_tokens: state.outputTokens,
    text: state.emittedText.join(''),
    tools: [...state.toolStates.values()].map((toolState) => ({
      id: toolState.id,
      name: toolState.name,
      input_json: toolState.allJson.join('')
    }))
  }
}

function sanitizeForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncateLogString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) {
    if (depth >= 5) return `[Array(${value.length})]`
    const items = value.slice(0, 25).map((item) => sanitizeForLog(item, depth + 1, seen))
    if (value.length > 25) items.push(`[+${value.length - 25} more items]`)
    return items
  }
  if (value instanceof Uint8Array) return `[Uint8Array length=${value.length}]`
  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]'
    seen.add(value as object)
    if (depth >= 6) return `[Object keys=${Object.keys(value as Record<string, unknown>).length}]`

    const entries = Object.entries(value as Record<string, unknown>)
    const result: Record<string, unknown> = {}
    for (const [index, [key, entryValue]] of entries.entries()) {
      if (index >= 40) {
        result.__truncated_keys = entries.length - index
        break
      }
      result[key] = isSecretKey(key) ? '[REDACTED]' : sanitizeForLog(entryValue, depth + 1, seen)
    }
    seen.delete(value as object)
    return result
  }
  return String(value)
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized === 'authorization'
    || normalized === 'x-api-key'
    || normalized === 'api_key'
    || normalized === 'apikey'
    || normalized === 'api-key'
    || normalized.endsWith('_token')
    || normalized.endsWith('-token')
    || normalized === 'token'
    || normalized.endsWith('_password')
    || normalized.endsWith('-password')
    || normalized === 'password'
    || normalized.endsWith('_secret')
    || normalized.endsWith('-secret')
    || normalized === 'secret'
}

function truncateLogString(value: string, maxLength = 4000): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}… [truncated ${value.length - maxLength} chars]`
}

function upstreamHeaders(config: ProxyConfig, hasBody: boolean): Record<string, string> {
  return {
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...(hasBody ? { 'content-type': 'application/json' } : {})
  }
}

function writeEvent(res: http.ServerResponse, event: string, data: any): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

async function readResponseJson(response: Response): Promise<any> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function sendJson(res: http.ServerResponse, status: number, body: any): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() })
  res.end(JSON.stringify(body))
}

function sendCorsPreflight(res: http.ServerResponse): void {
  res.writeHead(204, corsHeaders())
  res.end()
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,HEAD,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-api-key,anthropic-version,anthropic-beta'
  }
}

function anthropicError(type: string, message: string): any {
  return { type: 'error', error: { type, message } }
}

function upstreamError(status: number, json: any): Error {
  const message = json?.error?.message || json?.message || json?.raw || 'Unknown upstream error'
  const error = new Error(`OpenCode upstream error (${status}): ${message}`)
  ;(error as any).status = status
  return error
}

function parseJson(value: string, fallback: any): any {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}
