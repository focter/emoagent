import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from './knowledgeLoader.js';
import { analyzeUserMessage, buildSystemPrompt } from './prompt.js';
import { createKnowledgeMockReply } from './mock.js';
import { detectHighRisk, getSafetyResponse, getSafetyTextFromMessages } from './safety.js';
import { loadKnowledge as loadContextKnowledge } from '../src/knowledge/knowledgeLoader.js';
import { matchKnowledge } from '../src/knowledge/knowledgeMatcher.js';
import { buildKnowledgeContext } from '../src/knowledge/knowledgeContextBuilder.js';
import { createSafeLogMiddleware, updateSafeLog } from './logger.js';
import { createRateLimitMiddleware, getRateLimitConfig } from './rateLimiter.js';
import { getModelConfig, isModelConfigured } from './modelConfig.js';
import {
  readOpenAICompatibleStream,
  startNdjsonStream,
  streamText,
  writeNdjsonEvent,
} from './streaming.js';

export const app = express();
const port = Number(process.env.PORT) || 3001;
const modelConfig = getModelConfig();
const modelConfigured = isModelConfigured(modelConfig);
const rateLimitConfig = getRateLimitConfig();

// 启动阶段即完成全量校验；知识文件损坏时进程会带具体文件信息退出。
await loadKnowledge();

app.disable('x-powered-by');
app.use(createSafeLogMiddleware({ getMode: () => (modelConfigured ? 'api' : 'mock') }));
app.use(createRateLimitMiddleware({ config: rateLimitConfig }));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', async (_req, res) => {
  try {
    const knowledge = await loadKnowledge();
    res.json({
      ok: true,
      modelConfigured,
      modelName: modelConfigured ? modelConfig.model : null,
      mockMode: !modelConfigured,
      streamEnabled: true,
      rateLimitEnabled: rateLimitConfig.enabled,
      mode: modelConfigured ? 'llm' : 'mock',
      model: modelConfigured ? modelConfig.model : null,
      knowledge: {
        loaded: true,
        version: 2,
        issueTypes: knowledge.stats.issueTypes,
        mechanisms: knowledge.stats.mechanisms,
        interventions: knowledge.stats.interventions,
        safetyLevels: knowledge.stats.safetyLevels,
      },
    });
  } catch (error) {
    console.error('Knowledge health check failed:', error);
    res.status(500).json({ ok: false, error: '知识库加载失败。' });
  }
});

app.post('/api/chat', async (req, res) => {
  const messages = sanitizeMessages(req.body?.messages);
  if (!hasValidLatestUserMessage(messages)) {
    return res.status(400).json({ error: '请提供至少一条有效的用户消息。' });
  }

  const knowledgeContextState = await createKnowledgeContextState(messages.at(-1).content);

  let prepared;
  try {
    prepared = await prepareChat(messages, res, { knowledgeContextState });
  } catch {
    return res.status(500).json({ error: '本地知识库加载失败，请检查知识库文件。' });
  }

  if (prepared.safety) {
    return res.json(withOptionalDebug(
      { reply: prepared.reply, safety: true, mode: 'safety' },
      knowledgeContextState,
    ));
  }

  if (!modelConfigured) {
    return res.json(withOptionalDebug(
      { reply: prepared.mockReply, safety: false, mode: 'mock' },
      knowledgeContextState,
    ));
  }

  try {
    const response = await requestModel(prepared.systemPrompt, messages, false);
    if (!response.ok) {
      await response.text();
      return res.status(502).json({ error: '模型服务暂时无法响应，请稍后再试。' });
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(502).json({ error: '模型服务返回了空内容，请稍后再试。' });
    return res.json(withOptionalDebug(
      { reply, safety: false, mode: 'llm' },
      knowledgeContextState,
    ));
  } catch {
    return res.status(502).json({ error: '连接模型服务失败，请检查配置或稍后重试。' });
  }
});

app.post('/api/chat-stream', async (req, res) => {
  const messages = sanitizeMessages(req.body?.messages);
  if (!hasValidLatestUserMessage(messages)) {
    return res.status(400).json({ error: '请提供至少一条有效的用户消息。' });
  }

  const knowledgeContextState = await createKnowledgeContextState(messages.at(-1).content);

  let prepared;
  try {
    prepared = await prepareChat(messages, res, { knowledgeContextState });
  } catch {
    return res.status(500).json({ error: '本地知识库加载失败，请检查知识库文件。' });
  }

  if (prepared.safety) {
    startNdjsonStream(res);
    writeNdjsonEvent(res, withOptionalDebug(
      { type: 'meta', safety: true, mode: modelConfigured ? 'api' : 'mock' },
      knowledgeContextState,
    ));
    await streamText(res, prepared.reply, { chunkSize: 8, delayMs: 6 });
    writeNdjsonEvent(res, { type: 'done' });
    return res.end();
  }

  if (!modelConfigured) {
    startNdjsonStream(res);
    writeNdjsonEvent(res, withOptionalDebug(
      { type: 'meta', safety: false, mode: 'mock' },
      knowledgeContextState,
    ));
    await streamText(res, prepared.mockReply, { chunkSize: 4, delayMs: 12 });
    writeNdjsonEvent(res, { type: 'done' });
    return res.end();
  }

  let upstream;
  try {
    upstream = await requestModel(prepared.systemPrompt, messages, true);
  } catch {
    return res.status(502).json({ error: '连接模型服务失败，请检查配置或稍后重试。' });
  }

  if (!upstream.ok || !upstream.body) {
    await upstream.text();
    return res.status(502).json({ error: '模型服务暂时无法响应，请稍后再试。' });
  }

  startNdjsonStream(res);
  writeNdjsonEvent(res, withOptionalDebug(
    { type: 'meta', safety: false, mode: 'api' },
    knowledgeContextState,
  ));
  try {
    for await (const content of readOpenAICompatibleStream(upstream.body)) {
      if (!writeNdjsonEvent(res, { type: 'delta', content })) break;
    }
    writeNdjsonEvent(res, { type: 'done' });
  } catch {
    updateSafeLog(res, { error: true });
    writeNdjsonEvent(res, {
      type: 'error',
      message: '刚才连接有点不稳定，可以稍后再试。',
    });
  }
  return res.end();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distPath, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, req, res, _next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: '请求内容不是有效的 JSON。' });
  }
  if (!['/api/chat', '/api/chat-stream'].includes(req.path)) console.error(error);
  return res.status(500).json({ error: '服务器发生了意外错误。' });
});

if (isDirectExecution()) startServer();

export function startServer(listenPort = port) {
  return app.listen(listenPort, () => {
    const mode = modelConfigured ? `LLM: ${modelConfig.model}` : 'mock mode + local knowledge';
    const limit = rateLimitConfig.enabled
      ? `${rateLimitConfig.max} requests / ${rateLimitConfig.windowMs}ms`
      : 'rate limit disabled';
    console.log(`Server listening on http://localhost:${listenPort} (${mode}; ${limit})`);
  });
}

async function createKnowledgeContextState(userText) {
  const flags = getKnowledgeContextFlags();
  const state = {
    flags,
    context: null,
    error: '',
    boundary: flags.enabled ? 'enabled_context_pending' : 'disabled',
    promptInjected: false,
    debug: null,
  };
  if (!flags.enabled) return state;

  try {
    const knowledge = loadContextKnowledge();
    const matcherResult = matchKnowledge(knowledge, { text: userText });
    state.context = buildKnowledgeContext(matcherResult, { knowledge });
    state.boundary = state.context.generation_constraints.ordinary_interventions_allowed
      ? 'context_ready_ordinary_allowed'
      : 'context_high_risk_debug_only';
  } catch (error) {
    state.error = formatKnowledgeContextError(error);
    state.boundary = 'context_error';
  }

  updateKnowledgeContextDebug(state);
  return state;
}

function getKnowledgeContextFlags(environment = process.env) {
  return {
    enabled: parseBooleanEnv(environment.KNOWLEDGE_CONTEXT_ENABLED),
    debug: parseBooleanEnv(environment.KNOWLEDGE_CONTEXT_DEBUG),
    prompt: parseBooleanEnv(environment.KNOWLEDGE_CONTEXT_PROMPT_ENABLED),
  };
}

function parseBooleanEnv(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

function withOptionalDebug(payload, state) {
  return state?.debug ? { ...payload, debug: state.debug } : payload;
}

function formatKnowledgeContextError(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

function updateKnowledgeContextDebug(state) {
  if (!state?.flags?.debug) return;
  state.debug = {
    knowledgeContextEnabled: true,
    knowledgeContextDebug: true,
    knowledgeContextPromptEnabled: state.flags.prompt,
    knowledgeContextPromptInjected: state.promptInjected,
    knowledgeContextBoundary: state.boundary,
  };
  if (state.context) {
    state.debug.knowledgeContextSummary = summarizeKnowledgeContext(state.context);
    state.debug.knowledgeContext = state.context;
  }
  if (state.error) state.debug.knowledgeContextError = state.error;
}

function summarizeKnowledgeContext(context) {
  return {
    risk_level: context.risk_level,
    priority: context.priority,
    safety_top_rule_id: context.safety.top_rule_id,
    issue_type_ids: context.issue_types.map((item) => item.id),
    mechanism_ids: context.mechanisms.map((item) => item.id),
    intervention_ids: context.interventions.map((item) => item.id),
    response_style_ids: context.response_styles.map((item) => item.id),
    ordinary_interventions_allowed:
      context.generation_constraints.ordinary_interventions_allowed,
    warning_count: context.warnings.length,
  };
}

function applyKnowledgeContextPrompt(systemPrompt, state) {
  if (!state?.flags?.enabled || !state.flags.prompt) return systemPrompt;
  if (!state.context) {
    state.boundary = state.error ? 'prompt_not_injected_context_error' : 'prompt_not_injected_no_context';
    updateKnowledgeContextDebug(state);
    return systemPrompt;
  }
  if (!state.context.generation_constraints.ordinary_interventions_allowed) {
    state.boundary = 'prompt_not_injected_high_risk_context';
    updateKnowledgeContextDebug(state);
    return systemPrompt;
  }

  state.promptInjected = true;
  state.boundary = 'prompt_injected_ordinary_context';
  updateKnowledgeContextDebug(state);
  return `${systemPrompt}\n\n${formatKnowledgeContextPromptBlock(state.context)}`;
}

function formatKnowledgeContextPromptBlock(context) {
  const promptContext = {
    risk_level: context.risk_level,
    priority: context.priority,
    safety: {
      top_rule_id: context.safety.top_rule_id,
      matched_rule_ids: context.safety.matched_rule_ids,
      forbidden_actions: context.safety.forbidden_actions,
    },
    issue_types: context.issue_types.map((item) => ({
      id: item.id,
      name: item.name,
      response_goals: item.response_goals,
      recommended_interventions: item.recommended_interventions,
    })),
    mechanisms: context.mechanisms.map((item) => ({
      id: item.id,
      name: item.name,
      explain_to_user: item.explain_to_user,
      suitable_interventions: item.suitable_interventions,
    })),
    interventions: context.interventions
      .filter((item) => !item.disabled_by_safety)
      .map((item) => ({
        id: item.id,
        name: item.name,
        steps: item.steps,
        max_duration_minutes: item.max_duration_minutes,
        unsuitable_when: item.unsuitable_when,
      })),
    response_styles: context.response_styles,
    generation_constraints: context.generation_constraints,
    warnings: context.warnings,
  };

  return [
    'CONTROLLED READ-ONLY KNOWLEDGE CONTEXT',
    'Use this as secondary guidance only. Do not reveal card IDs, do not diagnose, do not claim treatment, and do not override safety routing.',
    JSON.stringify(promptContext, null, 2),
  ].join('\n');
}

function markKnowledgeContextBoundary(state, boundary) {
  if (!state?.flags?.enabled) return;
  state.boundary = boundary;
  updateKnowledgeContextDebug(state);
}

export async function prepareChat(messages, res = {}, options = {}) {
  const latestUserMessage = messages.at(-1).content;
  const risk = detectHighRisk(getSafetyTextFromMessages(messages));
  if (risk.isHighRisk) {
    updateSafeLog(res, { safety: true });
    markKnowledgeContextBoundary(options.knowledgeContextState, 'existing_safety_routing_authoritative');
    return { safety: true, riskLevel: risk.level, reply: getSafetyResponse(risk) };
  }

  const knowledge = await loadKnowledge();
  const context = { messages: messages.slice(0, -1) };
  const analysis = analyzeUserMessage(knowledge, latestUserMessage, context);
  updateSafeLog(res, {
    issueTypeIds: analysis.issueTypes.map((issue) => issue.id),
    mechanismIds: analysis.mechanisms.map((mechanism) => mechanism.id),
  });

  const systemPrompt = applyKnowledgeContextPrompt(
    buildSystemPrompt(knowledge, latestUserMessage, { ...context, analysis }),
    options.knowledgeContextState,
  );

  return {
    safety: false,
    systemPrompt,
    mockReply: createKnowledgeMockReply(latestUserMessage, analysis, knowledge),
  };
}

function isDirectExecution() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function requestModel(systemPrompt, messages, stream) {
  return fetch(`${modelConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${modelConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: modelConfig.model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: modelConfig.temperature,
      stream,
    }),
    signal: AbortSignal.timeout(modelConfig.timeoutMs),
  });
}

function hasValidLatestUserMessage(messages) {
  return messages.length > 0 && messages.at(-1)?.role === 'user';
}

function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((message) => message && ['user', 'assistant'].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || '').trim().slice(0, 8_000),
    }))
    .filter((message) => message.content)
    .slice(-30);
}
