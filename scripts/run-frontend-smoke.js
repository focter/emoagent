import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeCommand = process.execPath;
let serverProcess = null;

process.once('SIGINT', () => {
  stopServer();
  process.exit(130);
});

process.once('SIGTERM', () => {
  stopServer();
  process.exit(143);
});

try {
  const port = await getAvailablePort();
  serverProcess = await startServer(port);
  const baseUrl = `http://127.0.0.1:${port}`;

  await checkHome(baseUrl);
  await checkSpaFallback(baseUrl);
  await checkChatJson(baseUrl);
  await checkChatStream(baseUrl);

  console.log('Frontend smoke completed successfully.');
} catch (error) {
  console.error(`Frontend smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  stopServer();
}

async function startServer(port) {
  const env = {
    ...process.env,
    PORT: String(port),
    DOTENV_CONFIG_PATH: path.join(projectRoot, '.env.example'),
    OPENAI_API_KEY: '',
    LLM_API_KEY: '',
    RATE_LIMIT_ENABLED: 'false',
    ENABLE_SAFE_LOG: 'false',
  };
  const child = spawn(nodeCommand, ['server/index.js'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(prefixLines(chunk, '[server] ')));
  child.stderr.on('data', (chunk) => process.stderr.write(prefixLines(chunk, '[server] ')));
  await waitForHealth(port, child);
  return child;
}

async function checkHome(baseUrl) {
  console.log('==> Check production HTML and assets');
  const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5_000) });
  assert(response.ok, `GET / returned HTTP ${response.status}`);
  const html = await response.text();
  assert(html.includes('<div id="root"></div>'), 'index.html does not contain #root');
  const assets = extractAssets(html);
  assert(assets.some((asset) => asset.endsWith('.js')), 'index.html does not reference a JS asset');
  assert(assets.some((asset) => asset.endsWith('.css')), 'index.html does not reference a CSS asset');
  for (const asset of assets) {
    const assetResponse = await fetch(`${baseUrl}${asset}`, { signal: AbortSignal.timeout(5_000) });
    assert(assetResponse.ok, `${asset} returned HTTP ${assetResponse.status}`);
    const body = await assetResponse.text();
    assert(body.length > 0, `${asset} was empty`);
  }
}

async function checkSpaFallback(baseUrl) {
  console.log('==> Check SPA fallback');
  const response = await fetch(`${baseUrl}/chat/deep-link`, { signal: AbortSignal.timeout(5_000) });
  assert(response.ok, `SPA fallback returned HTTP ${response.status}`);
  const html = await response.text();
  assert(html.includes('<div id="root"></div>'), 'SPA fallback did not return index.html');
}

async function checkChatJson(baseUrl) {
  console.log('==> Check JSON chat API');
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '我最近很烦但不知道为什么' }] }),
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `/api/chat returned HTTP ${response.status}`);
  const body = await response.json();
  assert(body.mode === 'mock', `/api/chat expected mode=mock, received ${body.mode}`);
  assert(typeof body.reply === 'string' && body.reply.length > 0, '/api/chat returned an empty reply');
  assert(!('debug' in body), '/api/chat returned debug output by default');
}

async function checkChatStream(baseUrl) {
  console.log('==> Check NDJSON chat stream');
  const response = await fetch(`${baseUrl}/api/chat-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '我最近很烦但不知道为什么' }] }),
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `/api/chat-stream returned HTTP ${response.status}`);
  const text = await response.text();
  const events = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(events[0]?.type === 'meta', 'stream did not start with a meta event');
  assert(events[0].mode === 'mock', `stream expected mode=mock, received ${events[0].mode}`);
  assert(events.some((event) => event.type === 'delta' && event.content), 'stream had no delta content');
  assert(events.at(-1)?.type === 'done', 'stream did not end with a done event');
  assert(!('debug' in events[0]), 'stream returned debug output by default');
}

function extractAssets(html) {
  const assets = new Set();
  const pattern = /(?:src|href)="([^"]+\.(?:js|css))"/g;
  for (const match of html.matchAll(pattern)) {
    if (match[1].startsWith('/')) assets.add(match[1]);
  }
  return [...assets];
}

async function waitForHealth(port, child) {
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 10_000;
  let exited = false;
  let exitCode = null;
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited before health check passed, code ${exitCode}`);
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const health = await response.json();
        assert(health.mockMode === true, 'health check did not report mockMode=true');
        return;
      }
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`server did not become healthy at ${healthUrl}`);
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  serverProcess.kill();
  serverProcess = null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prefixLines(chunk, prefix) {
  return String(chunk)
    .split(/(\r?\n)/)
    .map((part) => part && !/^\r?\n$/.test(part) ? `${prefix}${part}` : part)
    .join('');
}
