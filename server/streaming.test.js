import test from 'node:test';
import assert from 'node:assert/strict';
import { readOpenAICompatibleStream, splitTextIntoChunks } from './streaming.js';

test('splits unicode text without breaking characters', () => {
  assert.deepEqual(splitTextIntoChunks('你好🙂世界', 2), ['你好', '🙂世', '界']);
});

test('parses OpenAI-compatible SSE chunks across byte boundaries', async () => {
  const encoder = new TextEncoder();
  const source = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n',
    '\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n',
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of source) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const output = [];
  for await (const content of readOpenAICompatibleStream(body)) output.push(content);
  assert.equal(output.join(''), '你好');
});
