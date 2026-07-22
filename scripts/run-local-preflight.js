import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeCommand = process.execPath;
const localMockEnv = {
  DOTENV_CONFIG_PATH: path.join(projectRoot, '.env.example'),
  OPENAI_API_KEY: '',
  LLM_API_KEY: '',
  RATE_LIMIT_ENABLED: 'false',
  ENABLE_SAFE_LOG: 'false',
};

const staticSteps = [
  {
    name: 'Secret scan',
    command: nodeCommand,
    args: ['scripts/check-secrets.js'],
  },
  {
    name: 'Mojibake scan',
    command: nodeCommand,
    args: ['scripts/check-mojibake.js', '--fail-on-found'],
  },
  {
    name: 'Knowledge sources check',
    command: nodeCommand,
    args: ['scripts/check-knowledge-sources.js'],
  },
  {
    name: 'Evidence cards check',
    command: nodeCommand,
    args: ['scripts/check-evidence-cards.js'],
  },
  {
    name: 'Decision cards check',
    command: nodeCommand,
    args: ['scripts/check-decision-cards.js'],
  },
  {
    name: 'Knowledge audit',
    command: nodeCommand,
    args: ['scripts/audit-knowledge.js'],
  },
  {
    name: 'Knowledge matcher eval',
    command: nodeCommand,
    args: ['evals/run-knowledge-matcher-evals.js'],
  },
  {
    name: 'Knowledge context integration eval',
    command: nodeCommand,
    args: ['evals/run-knowledge-context-integration-evals.js'],
  },
  {
    name: 'Knowledge prompt boundary eval',
    command: nodeCommand,
    args: ['evals/run-knowledge-prompt-injection-boundary-evals.js'],
  },
  {
    name: 'Manual knowledge experience eval',
    command: nodeCommand,
    args: ['evals/run-manual-experience-evals.js'],
  },
  {
    name: 'Unit tests',
    command: nodeCommand,
    args: ['--test'],
  },
  {
    name: 'Production build',
    command: nodeCommand,
    args: ['node_modules/vite/bin/vite.js', 'build'],
  },
  {
    name: 'Frontend production smoke',
    command: nodeCommand,
    args: ['scripts/run-frontend-smoke.js'],
  },
];

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
  for (const step of staticSteps) await runStep(step);

  const port = await getAvailablePort();
  serverProcess = await startMockServer(port);
  const chatUrl = `http://127.0.0.1:${port}/api/chat`;

  await runStep({
    name: 'Mock API conversation eval',
    command: nodeCommand,
    args: ['evals/run-evals.js'],
    env: { EVAL_API_URL: chatUrl },
  });
  await runStep({
    name: 'Mock API safety eval',
    command: nodeCommand,
    args: ['evals/run-safety-evals.js'],
    env: { SAFETY_EVAL_API_URL: chatUrl },
  });

  console.log('\nLocal preflight completed successfully.');
} catch (error) {
  console.error(`\nLocal preflight failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  stopServer();
}

async function runStep({ name, command, args, env = {} }) {
  console.log(`\n==> ${name}`);
  await runCommand(command, args, env);
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...localMockEnv, ...env },
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal
        ? `${command} ${args.join(' ')} exited by ${signal}`
        : `${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
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

async function startMockServer(port) {
  console.log(`\n==> Start mock backend on port ${port}`);
  const env = {
    ...process.env,
    ...localMockEnv,
    PORT: String(port),
  };

  const child = spawn(nodeCommand, ['server/index.js'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess = child;

  child.stdout.on('data', (chunk) => process.stdout.write(prefixLines(chunk, '[server] ')));
  child.stderr.on('data', (chunk) => process.stderr.write(prefixLines(chunk, '[server] ')));

  await waitForHealth(port, child);
  return child;
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
    if (exited) throw new Error(`mock backend exited before health check passed, code ${exitCode}`);
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const health = await response.json();
        if (health.mockMode === true) return;
        throw new Error('mock backend health check did not report mockMode=true');
      }
    } catch {
      await sleep(250);
    }
  }

  throw new Error(`mock backend did not become healthy at ${healthUrl}`);
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  serverProcess.kill();
  serverProcess = null;
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
