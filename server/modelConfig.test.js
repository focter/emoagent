import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelConfig, isModelConfigured } from './modelConfig.js';

test('uses OPENAI variables and keeps the API key non-enumerable', () => {
  const config = getModelConfig({
    OPENAI_API_KEY: 'test-secret-primary',
    OPENAI_BASE_URL: 'https://example.test/v1/',
    OPENAI_MODEL: 'example-model',
    OPENAI_TEMPERATURE: '0.25',
    OPENAI_TIMEOUT_MS: '45000',
  });

  assert.equal(isModelConfigured(config), true);
  assert.equal(config.apiKey, 'test-secret-primary');
  assert.equal(config.baseUrl, 'https://example.test/v1');
  assert.equal(config.model, 'example-model');
  assert.equal(config.temperature, 0.25);
  assert.equal(config.timeoutMs, 45_000);
  assert.equal(Object.keys(config).includes('apiKey'), false);
  assert.doesNotMatch(JSON.stringify(config), /test-secret-primary/);
});

test('supports legacy LLM variables when new names are absent', () => {
  const config = getModelConfig({
    LLM_API_KEY: 'test-secret-legacy',
    LLM_BASE_URL: 'https://legacy.test/v1',
    LLM_MODEL: 'legacy-model',
    LLM_TEMPERATURE: '0.6',
    LLM_TIMEOUT_MS: '20000',
  });

  assert.equal(isModelConfigured(config), true);
  assert.equal(config.apiKey, 'test-secret-legacy');
  assert.equal(config.baseUrl, 'https://legacy.test/v1');
  assert.equal(config.model, 'legacy-model');
  assert.equal(config.temperature, 0.6);
  assert.equal(config.timeoutMs, 20_000);
});

test('missing keys select mock mode and invalid numeric values use defaults', () => {
  const config = getModelConfig({
    OPENAI_TEMPERATURE: '9',
    OPENAI_TIMEOUT_MS: '10',
  });

  assert.equal(isModelConfigured(config), false);
  assert.equal(config.configured, false);
  assert.equal(config.temperature, 0.4);
  assert.equal(config.timeoutMs, 30_000);
});
