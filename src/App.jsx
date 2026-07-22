import { useEffect, useRef, useState } from 'react';

const SESSION_KEY = 'mindful-chat-messages';
const WELCOME_MESSAGE = {
  role: 'assistant',
  content:
    '你可以从任何一句话开始，不需要说得很完整。比如：我最近有点烦、我不知道自己怎么了、我总觉得很累。这里不会给你下诊断，我们可以先把你现在的感受慢慢说清楚。',
};

const QUICK_PROMPTS = [
  '我最近很烦',
  '我什么都不想做',
  '我总是自责',
  '我不知道自己怎么了',
  '我想聊聊人际关系',
];

class RequestError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function getInitialMessages() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    return Array.isArray(saved) && saved.length ? saved : [WELCOME_MESSAGE];
  } catch {
    return [WELCOME_MESSAGE];
  }
}

export default function App() {
  const [view, setView] = useState('home');
  const [messages, setMessages] = useState(getInitialMessages);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState('');
  const [runtimeMode, setRuntimeMode] = useState(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    const savedMessages = messages
      .filter((message) => message.content)
      .map(({ streaming: _streaming, debug: _debug, ...message }) => message);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(savedMessages));
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (view === 'chat') textareaRef.current?.focus();
  }, [view]);

  useEffect(() => {
    let active = true;
    fetch('/api/health')
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((health) => {
        if (active) setRuntimeMode(health.mockMode === false ? 'api' : 'mock');
      })
      .catch(() => {
        if (active) setRuntimeMode(null);
      });
    return () => {
      active = false;
    };
  }, []);

  async function sendMessage(content = input) {
    const text = content.trim();
    if (!text || isSending) return;

    const requestMessages = [...messages, { role: 'user', content: text }]
      .filter((message) => message.content)
      .map(({ streaming: _streaming, safety: _safety, debug: _debug, ...message }) => message);
    const assistantIndex = requestMessages.length;

    setMessages([
      ...requestMessages,
      { role: 'assistant', content: '', streaming: true, safety: false },
    ]);
    setInput('');
    setError('');
    setIsSending(true);

    try {
      try {
        const metadata = await requestStream(requestMessages, (delta) => {
          updateAssistantMessage(assistantIndex, (message) => ({
            ...message,
            content: `${message.content}${delta}`,
          }));
        });
        updateAssistantMessage(assistantIndex, (message) => ({
          ...message,
          streaming: false,
          safety: Boolean(metadata.safety),
          debug: metadata.debug,
        }));
      } catch (streamError) {
        if (streamError.status === 429) throw streamError;

        updateAssistantMessage(assistantIndex, (message) => ({
          ...message,
          content: '',
          streaming: true,
          safety: false,
        }));
        const fallback = await requestRegular(requestMessages);
        updateAssistantMessage(assistantIndex, () => ({
          role: 'assistant',
          content: fallback.reply,
          streaming: false,
          safety: Boolean(fallback.safety),
          debug: fallback.debug,
        }));
      }
    } catch (requestError) {
      setMessages((current) => current.filter((_, index) => index !== assistantIndex));
      setError(getFriendlyError(requestError));
    } finally {
      setIsSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  function updateAssistantMessage(index, updater) {
    setMessages((current) => current.map((message, messageIndex) =>
      messageIndex === index ? updater(message) : message));
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function clearConversation() {
    if (messages.length > 1 && !window.confirm('确定清空当前会话中的全部对话吗？')) return;
    setMessages([WELCOME_MESSAGE]);
    setError('');
    sessionStorage.removeItem(SESSION_KEY);
  }

  if (view === 'home') return <Home onStart={() => setView('chat')} runtimeMode={runtimeMode} />;

  return (
    <div className="app-shell">
      <header className="chat-header">
        <button className="brand-button" onClick={() => setView('home')} aria-label="返回首页">
          <Logo />
          <span>
            <strong>听见</strong>
            <small>心理健康觉察对话</small>
          </span>
        </button>
        <button className="clear-button" onClick={clearConversation} disabled={isSending}>
          清空对话
        </button>
      </header>

      <main className="chat-main">
        <div className="notice-bar">
          <span aria-hidden="true">i</span>
          <p>
            本工具不提供医疗诊断或心理治疗；对话保存在当前浏览器会话。配置真实模型时，消息会发送给所配置的模型服务商处理；请勿输入真实身份信息。遇到紧急危险，请联系现实中的可信任者和当地紧急服务。
          </p>
        </div>

        <section className="messages" aria-label="对话内容" aria-live="polite">
          {messages.map((message, index) => (
            <Message key={`${message.role}-${index}`} message={message} />
          ))}
          <div ref={messagesEndRef} />
        </section>

        <section className="composer-wrap" aria-label="发送消息">
          {messages.length <= 2 && (
            <div className="quick-prompts" aria-label="快捷话题">
              {QUICK_PROMPTS.map((prompt) => (
                <button key={prompt} onClick={() => sendMessage(prompt)} disabled={isSending}>
                  {prompt}
                </button>
              ))}
            </div>
          )}

          {error && <div className="error-message" role="alert">{error}</div>}

          <div className="composer">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="写下你此刻的感受……"
              rows="1"
              maxLength="8000"
              disabled={isSending}
              aria-label="消息内容"
            />
            <button
              className="send-button"
              onClick={() => sendMessage()}
              disabled={!input.trim() || isSending}
              aria-label="发送消息"
            >
              <SendIcon />
            </button>
          </div>
          <p className="composer-note">Enter 发送 · Shift + Enter 换行 · 请勿填写真实姓名、住址等身份信息</p>
          <ModeIndicator mode={runtimeMode} />
        </section>
      </main>
    </div>
  );
}

async function requestStream(messages, onDelta) {
  const response = await fetch('/api/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) throw await createResponseError(response);
  if (!response.body) throw new RequestError('流式响应不可读取');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const metadata = { safety: false, mode: '', debug: null };
  let buffer = '';
  let receivedDone = false;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : lines.pop() || '';

    for (const line of lines) {
      const event = parseStreamEvent(line);
      if (!event) continue;
      if (event.type === 'meta') Object.assign(metadata, event);
      if (event.type === 'delta' && typeof event.content === 'string') onDelta(event.content);
      if (event.type === 'error') throw new RequestError(event.message || '流式响应中断');
      if (event.type === 'done') receivedDone = true;
    }

    if (done) break;
  }

  if (buffer.trim()) {
    const event = parseStreamEvent(buffer);
    if (event?.type === 'delta' && typeof event.content === 'string') onDelta(event.content);
    if (event?.type === 'done') receivedDone = true;
    if (event?.type === 'error') throw new RequestError(event.message || '流式响应中断');
  }

  if (!receivedDone) throw new RequestError('流式响应意外中断');
  return metadata;
}

async function requestRegular(messages) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  if (!response.ok) throw await createResponseError(response);
  return response.json();
}

function parseStreamEvent(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    throw new RequestError('流式响应格式异常');
  }
}

async function createResponseError(response) {
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Do not expose raw server responses to the UI.
  }
  return new RequestError(body.error || '请求失败', response.status, body.code || '');
}

function getFriendlyError(error) {
  if (error?.status === 429 || error?.code === 'RATE_LIMITED') {
    return '请求有点频繁，先等一会儿再继续。';
  }
  return '刚才连接有点不稳定，可以稍后再试。';
}

function Home({ onStart, runtimeMode }) {
  return (
    <main className="home">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <nav className="home-nav" aria-label="网站导航">
        <div className="home-brand"><Logo /><strong>听见</strong></div>
        <span>心理健康觉察对话 Demo</span>
      </nav>

      <section className="hero">
        <div className="eyebrow"><span /> 给情绪一点被听见的空间</div>
        <h1>有些感受，<br />说出来才慢慢清楚。</h1>
        <p className="hero-copy">
          这里不是心理诊断工具，也不是心理治疗。它只是通过对话，帮助你把最近说不清的情绪、压力和身心变化慢慢说清楚。
        </p>
        <p className="hero-subcopy">你不需要注册，也不需要说得很完整。从一句“我最近不太对劲”开始就可以。</p>
        <button className="start-button" onClick={onStart}>
          开始聊聊 <span aria-hidden="true">→</span>
        </button>
      </section>

      <section className="info-cards" aria-label="使用说明">
        <article>
          <div className="card-icon"><ChatIcon /></div>
          <div><h2>自然对话</h2><p>不做测评，也不急着下结论。先从你愿意说的部分开始。</p></div>
        </article>
        <article>
          <div className="card-icon"><LockIcon /></div>
          <div><h2>会话内保存</h2><p>记录只保存在当前浏览器会话，可随时点击清空。</p></div>
        </article>
        <article>
          <div className="card-icon"><LeafIcon /></div>
          <div><h2>轻量觉察</h2><p>帮助你看见情绪、压力、身体反应和行为之间的联系。</p></div>
        </article>
      </section>

      <PrivacyBoundary />

      <footer className="home-footer">
        <ModeIndicator mode={runtimeMode} />
        <p><strong>请注意：</strong>本工具不提供医疗诊断、心理治疗或药物建议，也不能替代专业帮助。</p>
        <p>如有自伤、伤人或其他紧急危险，请立即联系身边可信任的人、当地紧急服务或医院急诊。</p>
      </footer>
    </main>
  );
}

function PrivacyBoundary() {
  return (
    <section className="privacy-panel" aria-label="隐私和使用边界">
      <div>
        <h2>本地与隐私边界</h2>
        <p>
          会话记录只写入当前浏览器会话的 sessionStorage。点击“清空对话”会移除当前会话记录；请仍然避免输入真实姓名、住址、电话、学校、公司或病历等身份信息。
        </p>
      </div>
      <ul>
        <li>未配置 API Key 时，后端使用本地 mock 回复，不调用外部模型。</li>
        <li>配置真实模型时，本轮消息会发送给所配置的 OpenAI-compatible 服务商处理。</li>
        <li>后端默认不保存对话正文；开启安全日志时也只记录白名单运行字段。</li>
      </ul>
    </section>
  );
}

function ModeIndicator({ mode }) {
  if (!mode) return null;
  return (
    <p className="mode-indicator" aria-label="当前回复模式">
      <span aria-hidden="true" />
      {mode === 'api'
        ? 'API 模式：当前为在线模型回复'
        : 'Mock 模式：当前为本地演示回复'}
    </p>
  );
}

function Message({ message }) {
  const isUser = message.role === 'user';
  return (
    <div className={`message-row ${isUser ? 'user-row' : 'assistant-row'}`}>
      {!isUser && <div className="avatar" aria-hidden="true">听</div>}
      <div className={`bubble ${isUser ? 'user-bubble' : 'assistant-bubble'} ${message.safety ? 'safety-bubble' : ''}`}>
        {message.content && <span className="message-content">{message.content}</span>}
        {message.streaming && (
          <span className="responding-status" aria-label="正在回应">
            正在回应
            <span className="responding-dots" aria-hidden="true"><i /><i /><i /></span>
          </span>
        )}
        {!isUser && message.debug && <KnowledgeDebugPanel debug={message.debug} />}
      </div>
    </div>
  );
}

function KnowledgeDebugPanel({ debug }) {
  const context = debug.knowledgeContext;
  const summary = debug.knowledgeContextSummary;
  if (!context && !summary && !debug.knowledgeContextError) return null;
  const riskLevel = context?.risk_level || summary?.risk_level || 'unknown';
  const interventions = context?.interventions || [];
  const disabledInterventions = interventions.filter((item) => item.disabled_by_safety);
  const highRisk = riskLevel === 'high' || riskLevel === 'critical';
  const ordinaryAllowed = context?.generation_constraints?.ordinary_interventions_allowed
    ?? summary?.ordinary_interventions_allowed;

  return (
    <details className={`knowledge-debug ${highRisk ? 'knowledge-debug-risk' : ''}`}>
      <summary>Knowledge debug</summary>
      {highRisk && (
        <div className="knowledge-debug-alert">
          Safety routing remains authoritative. Ordinary interventions are disabled.
        </div>
      )}
      <dl>
        <div><dt>Risk level</dt><dd>{riskLevel}</dd></div>
        <div><dt>Issue types</dt><dd>{formatDebugItems(context?.issue_types, summary?.issue_type_ids)}</dd></div>
        <div><dt>Mechanisms</dt><dd>{formatDebugItems(context?.mechanisms, summary?.mechanism_ids)}</dd></div>
        <div><dt>Interventions</dt><dd>{formatDebugInterventions(interventions, summary?.intervention_ids)}</dd></div>
        <div><dt>Styles</dt><dd>{formatDebugItems(context?.response_styles, summary?.response_style_ids)}</dd></div>
        <div><dt>Ordinary allowed</dt><dd>{String(ordinaryAllowed)}</dd></div>
        <div><dt>Disabled count</dt><dd>{String(disabledInterventions.length)}</dd></div>
        <div><dt>Prompt injected</dt><dd>{debug.knowledgeContextPromptInjected ? 'true' : 'false'}</dd></div>
        <div><dt>Boundary</dt><dd>{debug.knowledgeContextBoundary || 'unknown'}</dd></div>
        {debug.knowledgeContextError && <div><dt>error</dt><dd>{debug.knowledgeContextError}</dd></div>}
      </dl>
      {disabledInterventions.length > 0 && (
        <div className="knowledge-debug-disabled">
          disabled interventions: {disabledInterventions.map((item) => item.id).join(', ')}
        </div>
      )}
      <details className="knowledge-debug-json">
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify({
          knowledgeContextSummary: summary,
          knowledgeContext: context,
          knowledgeContextError: debug.knowledgeContextError,
        }, null, 2)}</pre>
      </details>
    </details>
  );
}

function formatDebugItems(items, fallbackIds) {
  if (Array.isArray(items) && items.length > 0) {
    return items.map((item) => item.id).join(', ');
  }
  return formatDebugList(fallbackIds);
}

function formatDebugInterventions(items, fallbackIds) {
  if (Array.isArray(items) && items.length > 0) {
    return items.map((item) => item.disabled_by_safety ? `${item.id} (disabled)` : item.id).join(', ');
  }
  return formatDebugList(fallbackIds);
}

function formatDebugList(values) {
  return Array.isArray(values) && values.length ? values.join(', ') : 'none';
}

function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none"><path d="M12 25.5c-2.8-2.5-4.5-5.9-4.5-9.2C7.5 10.6 11.7 7 16 7c2.1 0 3.7.8 4.7 2.2C21.8 7.8 23.4 7 25.5 7c4.3 0 7.5 3.6 7.5 8.2 0 8.4-9.2 14.7-12.3 16.8-1.5-1-4.9-3.4-7.8-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M13.5 18.2c2.8 0 2.8 4 5.6 4s2.8-7 5.6-7 2.8 3 5.6 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
    </span>
  );
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" fill="none"><path d="m5 12 14-7-4.8 14-2.8-5.8L5 12Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="m11.4 13.2 3.1-3.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>;
}

function ChatIcon() {
  return <svg viewBox="0 0 24 24" fill="none"><path d="M20 11.4a7.4 7.4 0 0 1-8 7.3 8.6 8.6 0 0 1-3-.9L4.5 19l1.3-3.6A7.4 7.4 0 1 1 20 11.4Z" stroke="currentColor" strokeWidth="1.6"/><path d="M8.5 11.5h.1m3.3 0h.1m3.3 0h.1" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.6"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>;
}

function LeafIcon() {
  return <svg viewBox="0 0 24 24" fill="none"><path d="M19.5 4.5C12 4.5 6.7 7.3 6.7 13c0 3.2 2.1 5.3 5.2 5.3 5.8 0 7.6-6.6 7.6-13.8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M4.5 20c2.3-4.6 5.8-7.5 10.7-9.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>;
}
