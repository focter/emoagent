const CHAT_ROUTES = new Set(['/api/chat', '/api/chat-stream']);
const SAFE_LOG_FIELDS = [
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
];

export function isSafeLoggingEnabled(environment = process.env) {
  return String(environment.ENABLE_SAFE_LOG || '').trim().toLowerCase() === 'true';
}

export function createSafeLogMiddleware({
  getMode = () => 'mock',
  isEnabled = isSafeLoggingEnabled,
  writeLog = (entry) => console.log(JSON.stringify(entry)),
} = {}) {
  return function safeLogMiddleware(req, res, next) {
    if (!isEnabled() || req.method !== 'POST' || !CHAT_ROUTES.has(req.path)) {
      return next();
    }

    const startedAt = performance.now();
    res.locals.safeLog = {
      route: req.path,
      stream: req.path === '/api/chat-stream',
      safety: false,
      issueTypeIds: [],
      mechanismIds: [],
      mode: normalizeMode(getMode()),
      rateLimited: false,
      error: false,
    };

    let hasLogged = false;
    const finalize = () => {
      if (hasLogged) return;
      hasLogged = true;

      const metadata = res.locals.safeLog || {};
      const entry = buildSafeLogEntry({
        time: new Date().toISOString(),
        route: metadata.route,
        stream: metadata.stream,
        safety: metadata.safety,
        issueTypeIds: metadata.issueTypeIds,
        mechanismIds: metadata.mechanismIds,
        mode: metadata.mode,
        durationMs: performance.now() - startedAt,
        rateLimited: metadata.rateLimited,
        error: metadata.error || res.statusCode >= 400 || !res.writableEnded,
      });

      writeLog(entry);
    };

    res.once('finish', finalize);
    res.once('close', finalize);
    return next();
  };
}

export function updateSafeLog(res, metadata = {}) {
  if (!res.locals?.safeLog) return;

  if (typeof metadata.safety === 'boolean') res.locals.safeLog.safety = metadata.safety;
  if (Array.isArray(metadata.issueTypeIds)) {
    res.locals.safeLog.issueTypeIds = normalizeIds(metadata.issueTypeIds);
  }
  if (Array.isArray(metadata.mechanismIds)) {
    res.locals.safeLog.mechanismIds = normalizeIds(metadata.mechanismIds);
  }
  if (metadata.mode) res.locals.safeLog.mode = normalizeMode(metadata.mode);
  if (typeof metadata.rateLimited === 'boolean') {
    res.locals.safeLog.rateLimited = metadata.rateLimited;
  }
  if (typeof metadata.error === 'boolean') res.locals.safeLog.error = metadata.error;
}

export function buildSafeLogEntry(metadata = {}) {
  const route = CHAT_ROUTES.has(metadata.route) ? metadata.route : '/api/chat';
  const entry = {
    time: typeof metadata.time === 'string' ? metadata.time : new Date().toISOString(),
    route,
    stream: route === '/api/chat-stream' || Boolean(metadata.stream),
    safety: Boolean(metadata.safety),
    issueTypeIds: normalizeIds(metadata.issueTypeIds),
    mechanismIds: normalizeIds(metadata.mechanismIds),
    mode: normalizeMode(metadata.mode),
    durationMs: Math.max(0, Math.round(Number(metadata.durationMs) || 0)),
    rateLimited: Boolean(metadata.rateLimited),
    error: Boolean(metadata.error),
  };

  return Object.fromEntries(SAFE_LOG_FIELDS.map((field) => [field, entry[field]]));
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && /^[a-z0-9_]+$/i.test(id)))];
}

function normalizeMode(mode) {
  return mode === 'api' ? 'api' : 'mock';
}
