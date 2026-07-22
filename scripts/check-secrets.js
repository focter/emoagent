import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const findings = [];
const skippedDirectories = new Set([
  '.git',
  '.agents',
  '.codex',
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
]);
const skippedFallbackPaths = new Set(['knowledge_sources/raw']);
const allowedEnvironmentExamples = new Set(['.env.example']);
const textExtensions = new Set([
  '', '.css', '.csv', '.env', '.example', '.html', '.htm', '.js', '.jsx',
  '.json', '.md', '.mjs', '.cjs', '.svg', '.txt', '.yaml', '.yml',
]);
const tokenPatterns = [
  ['OpenAI-style API token', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['Stripe live secret', /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g],
  ['Private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  [
    'Credential embedded in URL',
    /\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~-]+:[^\s/@]{4,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?=[/:?#\s]|$)/gi,
  ],
];

for (const relativePath of listCandidateFiles()) scanFile(relativePath);

if (findings.length > 0) {
  console.error('Potential secrets detected (values are intentionally hidden):');
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line} — ${finding.reason}`);
  }
  console.error('\nRemove the value from the repository and rotate it if it was ever exposed.');
  process.exitCode = 1;
} else {
  console.log('Secret scan passed: no committed or commit-candidate secrets detected.');
}

function listCandidateFiles() {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return [...new Set(output.split('\0').filter(Boolean))].sort();
  } catch {
    return walk(projectRoot).sort();
  }
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(projectRoot, absolutePath).replaceAll('\\', '/');
    if (entry.isDirectory()
      && (skippedDirectories.has(entry.name) || skippedFallbackPaths.has(relativePath))) continue;
    if (entry.isFile() && isFallbackIgnoredFile(entry.name)) continue;
    if (entry.isDirectory()) {
      files.push(...walk(absolutePath));
    } else if (entry.isFile()) {
      files.push(path.relative(projectRoot, absolutePath));
    }
  }
  return files;
}

function isFallbackIgnoredFile(basename) {
  if (/^\.env(?:\..+)?$/i.test(basename) && !allowedEnvironmentExamples.has(basename)) return true;
  return /^tmp-.*\.json$/i.test(basename) || /\.log$/i.test(basename);
}

function scanFile(relativePath) {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  const basename = path.basename(relativePath);
  if (isForbiddenSecretFilename(basename)) {
    addFinding(normalizedPath, 1, 'secret-bearing filename must not be committed');
    return;
  }

  const absolutePath = path.join(projectRoot, relativePath);
  if (!existsSync(absolutePath) || statSync(absolutePath).size > 2_000_000) return;
  const extension = path.extname(relativePath).toLowerCase();
  if (!textExtensions.has(extension)) return;

  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) return;
  const lines = buffer.toString('utf8').split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const [reason, pattern] of tokenPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) addFinding(normalizedPath, index + 1, reason);
    }
    if (containsNonPlaceholderSecretAssignment(line)) {
      addFinding(normalizedPath, index + 1, 'non-placeholder value assigned to a sensitive variable');
    }
  });
}

function isForbiddenSecretFilename(basename) {
  if (/^\.env(?:\..+)?$/i.test(basename) && !allowedEnvironmentExamples.has(basename)) return true;
  return /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.[^.]+)?)$/i.test(basename)
    || /\.(?:key|pem|p12|pfx)$/i.test(basename);
}

function containsNonPlaceholderSecretAssignment(line) {
  const match = line.match(
    /^\s*["']?([A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|secret(?:[_-]?key)?|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|private[_-]?key|access[_-]?key))["']?\s*[:=]\s*["']?([^"',\s#]+)/i,
  );
  if (!match) return false;
  const value = match[2].trim();
  return !isPlaceholder(value);
}

function isPlaceholder(value) {
  return /^(?:your(?:[-_].*)?|example(?:[-_].*)?|placeholder|changeme|dummy|fake|mock|test|none|null|undefined|true|false|x+|\*+|<[^>]+>|\$\{[^}]+\}|process\.env\.|(?:test|fake|dummy|example)[-_](?:key|token|secret|password)(?:[-_][A-Za-z0-9]+)*)$/i.test(value)
    || value.length === 0;
}

function addFinding(filePath, line, reason) {
  if (!findings.some((item) => item.path === filePath && item.line === line && item.reason === reason)) {
    findings.push({ path: filePath, line, reason });
  }
}
