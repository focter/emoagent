const encoderDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function startNdjsonStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

export function writeNdjsonEvent(res, event) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`${JSON.stringify(event)}\n`);
  return true;
}

export async function streamText(res, text, { chunkSize = 4, delayMs = 12 } = {}) {
  for (const chunk of splitTextIntoChunks(text, chunkSize)) {
    if (!writeNdjsonEvent(res, { type: 'delta', content: chunk })) return false;
    if (delayMs > 0) await encoderDelay(delayMs);
  }
  return true;
}

export function splitTextIntoChunks(text, chunkSize = 4) {
  const characters = Array.from(String(text || ''));
  const size = Math.max(1, Number.parseInt(chunkSize, 10) || 1);
  const chunks = [];
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(''));
  }
  return chunks;
}

export async function* readOpenAICompatibleStream(body) {
  if (!body?.getReader) throw new Error('模型流不可读取');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : lines.pop() || '';

    for (const line of lines) {
      const result = parseSseLine(line);
      if (result.done) return;
      if (result.content) yield result.content;
    }

    if (done) {
      if (buffer.trim()) {
        const result = parseSseLine(buffer);
        if (result.content) yield result.content;
      }
      return;
    }
  }
}

function parseSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return {};

  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return { done: true };

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error('模型流包含无法解析的数据');
  }

  if (parsed?.error) throw new Error('模型流返回错误');

  const content = parsed?.choices?.[0]?.delta?.content;
  return { content: typeof content === 'string' ? content : '' };
}
