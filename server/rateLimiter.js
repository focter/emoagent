import { updateSafeLog } from './logger.js';

const LIMITED_ROUTES = new Set(['/api/chat', '/api/chat-stream']);
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 20;

export function getRateLimitConfig(environment = process.env) {
  return {
    enabled: String(environment.RATE_LIMIT_ENABLED || '').trim().toLowerCase() === 'true',
    windowMs: toPositiveInteger(environment.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS),
    max: toPositiveInteger(environment.RATE_LIMIT_MAX, DEFAULT_MAX),
  };
}

export function createRateLimitMiddleware({
  config = getRateLimitConfig(),
  now = Date.now,
  store = new Map(),
} = {}) {
  let requestCounter = 0;

  return function rateLimitMiddleware(req, res, next) {
    if (!config.enabled || req.method !== 'POST' || !LIMITED_ROUTES.has(req.path)) {
      return next();
    }

    const currentTime = now();
    const source = getRequestSource(req);
    let record = store.get(source);

    if (!record || record.resetAt <= currentTime) {
      record = { count: 0, resetAt: currentTime + config.windowMs };
      store.set(source, record);
    }

    if (record.count >= config.max) {
      updateSafeLog(res, { rateLimited: true });
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((record.resetAt - currentTime) / 1_000))));
      return res.status(429).json({
        error: '请求有点频繁，先等一会儿再继续。',
        code: 'RATE_LIMITED',
      });
    }

    record.count += 1;
    requestCounter += 1;
    if (requestCounter % 1_000 === 0) removeExpiredEntries(store, currentTime);
    return next();
  };
}

function getRequestSource(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function removeExpiredEntries(store, currentTime) {
  for (const [key, record] of store.entries()) {
    if (record.resetAt <= currentTime) store.delete(key);
  }
}
