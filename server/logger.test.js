import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildSafeLogEntry,
  createSafeLogMiddleware,
  isSafeLoggingEnabled,
  updateSafeLog,
} from './logger.js';

test('safe logging is enabled only by an explicit true value', () => {
  assert.equal(isSafeLoggingEnabled({ ENABLE_SAFE_LOG: 'true' }), true);
  assert.equal(isSafeLoggingEnabled({ ENABLE_SAFE_LOG: ' TRUE ' }), true);
  assert.equal(isSafeLoggingEnabled({ ENABLE_SAFE_LOG: 'false' }), false);
  assert.equal(isSafeLoggingEnabled({}), false);
});

test('safe log entry contains only the approved fields', () => {
  const entry = buildSafeLogEntry({
    time: '2026-06-21T12:00:00.000Z',
    route: '/api/chat-stream',
    stream: true,
    safety: false,
    issueTypeIds: ['self_blame', 'self_blame', '../invalid'],
    mechanismIds: ['self_blame_cycle'],
    mode: 'api',
    durationMs: 12.6,
    rateLimited: false,
    error: false,
    userInput: 'sensitive user content',
    modelResponse: 'sensitive model response',
    apiKey: 'secret-key',
  });

  assert.deepEqual(Object.keys(entry), [
    'time',
    'route',
    'stream',
    'safety',
    'issueTypeIds',
    'mechanismIds',
    'mode',
    'durationMs',
    'rateLimited',
    'error',
  ]);
  assert.deepEqual(entry.issueTypeIds, ['self_blame']);
  assert.equal(entry.durationMs, 13);
  assert.doesNotMatch(JSON.stringify(entry), /sensitive|secret-key/);
});

test('middleware writes one redacted record after a chat response finishes', () => {
  const writtenEntries = [];
  const middleware = createSafeLogMiddleware({
    getMode: () => 'mock',
    isEnabled: () => true,
    writeLog: (entry) => writtenEntries.push(entry),
  });
  const request = { method: 'POST', path: '/api/chat-stream' };
  const response = new EventEmitter();
  response.locals = {};
  response.statusCode = 200;
  response.writableEnded = true;

  let nextWasCalled = false;
  middleware(request, response, () => {
    nextWasCalled = true;
  });
  updateSafeLog(response, {
    safety: false,
    issueTypeIds: ['anxiety_worry'],
    mechanismIds: ['stress_response'],
  });
  response.emit('finish');
  response.emit('close');

  assert.equal(nextWasCalled, true);
  assert.equal(writtenEntries.length, 1);
  assert.deepEqual(writtenEntries[0].issueTypeIds, ['anxiety_worry']);
  assert.deepEqual(writtenEntries[0].mechanismIds, ['stress_response']);
  assert.equal(writtenEntries[0].mode, 'mock');
  assert.equal(writtenEntries[0].route, '/api/chat-stream');
  assert.equal(writtenEntries[0].stream, true);
  assert.equal(writtenEntries[0].rateLimited, false);
  assert.equal(writtenEntries[0].error, false);
});

test('middleware does not attach logging when safe logging is disabled', () => {
  const writtenEntries = [];
  const middleware = createSafeLogMiddleware({
    isEnabled: () => false,
    writeLog: (entry) => writtenEntries.push(entry),
  });
  const request = { method: 'POST', path: '/api/chat' };
  const response = new EventEmitter();
  response.locals = {};

  middleware(request, response, () => {});
  response.emit('finish');

  assert.equal(writtenEntries.length, 0);
  assert.equal(response.locals.safeLog, undefined);
});
