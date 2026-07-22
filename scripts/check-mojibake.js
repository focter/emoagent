import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const failOnFound = args.has('--fail-on-found');

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
]);

const EXCLUDED_FILES = new Set([
  'package-lock.json',
]);

const TEXT_EXTENSIONS = new Set([
  '.css',
  '.csv',
  '.env',
  '.example',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.mjs',
  '.txt',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

const PATTERNS = [
  pattern('replacement_or_gbk_garbled', ['\\ufffd', '\\u951f']),
  pattern('latin1_utf8_mojibake', ['\\u8119', '\\u8117']),
  pattern('common_utf8_mojibake_sequences', ['\\u8302\\u9a74\\u9646', '\\u8305\\u9234', '\\u9234\\u20ac']),
  pattern('traditional_mojibake_markers', ['\\u95b3', '\\u95b8', '\\u93b4', '\\u9428']),
];

const findings = [];

await scanDirectory(projectRoot);

if (jsonMode) {
  console.log(JSON.stringify({ summary: summarize(findings), findings }, null, 2));
} else {
  printHumanReadable(findings);
}

if (failOnFound && findings.length > 0) process.exitCode = 1;

async function scanDirectory(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        await scanDirectory(path.join(directory, entry.name));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(directory, entry.name);
    if (!shouldScanFile(filePath, entry.name)) continue;
    await scanFile(filePath);
  }
}

function shouldScanFile(filePath, fileName) {
  if (EXCLUDED_FILES.has(fileName)) return false;
  const extension = path.extname(fileName).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return true;
  if (fileName.startsWith('.env')) return true;
  return false;
}

async function scanFile(filePath) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return;
  }
  if (fileStat.size > 2_000_000) return;

  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return;
  }

  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const item of PATTERNS) {
      if (item.regex.test(line)) {
        findings.push({
          file: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
          line: index + 1,
          pattern: item.name,
          fragment: compactFragment(line),
        });
      }
    }
  }
}

function pattern(name, escapedTerms) {
  const terms = escapedTerms.map((term) => unescapeTerm(term));
  return {
    name,
    regex: new RegExp(terms.map(escapeRegExp).join('|'), 'u'),
  };
}

function unescapeTerm(value) {
  return JSON.parse(`"${value}"`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compactFragment(line) {
  const compact = line.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function summarize(items) {
  const byFile = new Map();
  for (const item of items) byFile.set(item.file, (byFile.get(item.file) || 0) + 1);
  return {
    total_findings: items.length,
    files_with_findings: byFile.size,
    top_files: [...byFile.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12)
      .map(([file, count]) => ({ file, count })),
  };
}

function printHumanReadable(items) {
  const summary = summarize(items);
  console.log('');
  console.log('Mojibake scan summary:');
  console.log(`* total_findings: ${summary.total_findings}`);
  console.log(`* files_with_findings: ${summary.files_with_findings}`);
  if (summary.top_files.length > 0) {
    console.log('* top_files:');
    for (const item of summary.top_files) {
      console.log(`  - ${item.file}: ${item.count}`);
    }
  }
  if (items.length === 0) return;

  console.log('');
  console.log('Findings:');
  for (const item of items) {
    console.log('-'.repeat(72));
    console.log(`${item.file}:${item.line}`);
    console.log(`pattern: ${item.pattern}`);
    console.log(`fragment: ${item.fragment}`);
  }
}
