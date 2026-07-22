const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_TIMEOUT_MS = 30_000;

export function getModelConfig(environment = process.env) {
  const apiKey = firstNonEmpty(environment.OPENAI_API_KEY, environment.LLM_API_KEY);
  const baseUrl = firstNonEmpty(
    environment.OPENAI_BASE_URL,
    environment.LLM_BASE_URL,
    DEFAULT_BASE_URL,
  ).replace(/\/$/, '');
  const model = firstNonEmpty(environment.OPENAI_MODEL, environment.LLM_MODEL, DEFAULT_MODEL);
  const temperature = parseTemperature(
    firstNonEmpty(environment.OPENAI_TEMPERATURE, environment.LLM_TEMPERATURE),
  );
  const timeoutMs = parseTimeout(
    firstNonEmpty(environment.OPENAI_TIMEOUT_MS, environment.LLM_TIMEOUT_MS),
  );

  const config = {
    configured: Boolean(apiKey),
    baseUrl,
    model,
    temperature,
    timeoutMs,
  };

  Object.defineProperty(config, 'apiKey', {
    value: apiKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(config);
}

export function isModelConfigured(config = getModelConfig()) {
  return Boolean(config?.configured && config?.apiKey);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseTemperature(value) {
  if (!value) return DEFAULT_TEMPERATURE;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2
    ? parsed
    : DEFAULT_TEMPERATURE;
}

function parseTimeout(value) {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 300_000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}
