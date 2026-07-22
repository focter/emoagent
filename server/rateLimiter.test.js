import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimitMiddleware, getRateLimitConfig } from './rateLimiter.js';

test('rate limit config uses safe defaults and explicit enablement', () => {
  assert.deepEqual(getRateLimitConfig({}), {
    enabled: false,
    windowMs: 60_000,
    max: 20,
  });
  assert.deepEqual(getRateLimitConfig({
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_WINDOW_MS: '1000',
    RATE_LIMIT_MAX: '2',
  }), {
    enabled: true,
    windowMs: 1_000,
    max: 2,
  });
});

test('limits chat and stream routes together for the same request source', () => {
  let currentTime = 1_000;
  const middleware = createRateLimitMiddleware({
    config: { enabled: true, windowMs: 60_000, max: 2 },
    now: () => currentTime,
  });

  const first = runMiddleware(middleware, '/api/chat', '127.0.0.1');
  const second = runMiddleware(middleware, '/api/chat-stream', '127.0.0.1');
  const third = runMiddleware(middleware, '/api/chat', '127.0.0.1');

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, true);
  assert.equal(third.statusCode, 429);
  assert.equal(third.body.code, 'RATE_LIMITED');
  assert.equal(third.locals.safeLog.rateLimited, true);

  currentTime += 60_001;
  const afterReset = runMiddleware(middleware, '/api/chat', '127.0.0.1');
  assert.equal(afterReset.nextCalled, true);
});

test('does not limit unrelated routes or disabled configurations', () => {
  const enabled = createRateLimitMiddleware({
    config: { enabled: true, windowMs: 60_000, max: 1 },
  });
  assert.equal(runMiddleware(enabled, '/api/health', '127.0.0.1').nextCalled, true);

  const disabled = createRateLimitMiddleware({
    config: { enabled: false, windowMs: 60_000, max: 1 },
  });
  assert.equal(runMiddleware(disabled, '/api/chat', '127.0.0.1').nextCalled, true);
  assert.equal(runMiddleware(disabled, '/api/chat', '127.0.0.1').nextCalled, true);
});

function runMiddleware(middleware, path, ip) {
  const result = {
    locals: { safeLog: {} },
    headers: {},
    statusCode: 200,
    body: null,
    nextCalled: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  middleware({ method: 'POST', path, ip, socket: {} }, result, () => {
    result.nextCalled = true;
  });
  return result;
}
