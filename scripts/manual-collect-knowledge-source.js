import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const knowledgeSourcesRoot = path.join(projectRoot, 'knowledge_sources');
const rawRoot = path.join(knowledgeSourcesRoot, 'raw');
const notesRoot = path.join(knowledgeSourcesRoot, 'notes');
const registryDirectory = path.join(knowledgeSourcesRoot, 'registry');
const registryJsonPath = path.join(registryDirectory, 'source_registry.json');
const registryCsvPath = path.join(registryDirectory, 'source_registry.csv');
const reportPath = path.join(registryDirectory, 'collection_report.md');
const supportedExtensions = new Set(['.pdf', '.html', '.htm', '.txt']);
const protectedStatuses = new Set(['summarized', 'needs_review', 'approved', 'deprecated']);
const officialDomains = new Set([
  'who.int',
  'nhc.gov.cn',
  'nimh.nih.gov',
  'england.nhs.uk',
  'nhs.uk',
  'nice.org.uk',
  'moe.gov.cn',
  'psychiatry.org',
]);
const csvFields = [
  'source_id',
  'title',
  'organization',
  'year',
  'language',
  'type',
  'topic_tags',
  'priority',
  'used_for',
  'limitations',
  'url',
  'file_path',
  'status',
  'access_date',
  'notes_done',
];
const notesFiles = {
  safety: 'safety_notes.md',
  self_help: 'self_help_notes.md',
  common_issues: 'common_issues_notes.md',
  methods: 'methods_notes.md',
  student_mental_health: 'student_notes.md',
  ai_ethics_privacy: 'ai_ethics_notes.md',
};

main().catch((error) => {
  console.error(`Manual knowledge source collection failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const officialUrl = validateOfficialUrl(options.url);
  const inputFile = await validateInputFile(options.file);
  const records = await loadRegistry();
  const record = records.find((item) => item?.source_id === options.id);
  if (!record) throw new Error(`source_id 不存在：${options.id}`);

  const previousStatus = String(record.status || '');
  if (protectedStatuses.has(previousStatus) && !options.force) {
    throw new Error(`source_id=${options.id} 当前 status=${previousStatus}；必须使用 --force 才能覆盖。`);
  }

  const finalFile = await placeFile(inputFile, record, options.id);
  record.url = officialUrl;
  record.file_path = finalFile.relative;
  record.status = 'collected';
  record.access_date = currentDate();
  if (!record.notes_done) record.notes_done = 'no';
  if (record.status === 'approved') {
    throw new Error('内部保护：手动补录不能自动设置 approved。');
  }

  await syncRegistry(records);
  await appendManualReport({
    date: record.access_date,
    source_id: record.source_id,
    url: record.url,
    file_path: record.file_path,
    previous_status: previousStatus,
    new_status: record.status,
  });
  const notesResult = await ensureNotesSection(record);

  console.log('Manual knowledge source collection completed.');
  console.log(`- source_id: ${record.source_id}`);
  console.log(`- file_path: ${record.file_path}`);
  console.log(`- previous_status: ${previousStatus || '(empty)'}`);
  console.log(`- new_status: ${record.status}`);
  console.log(`- file_action: ${finalFile.copied ? 'copied into knowledge_sources/raw' : 'used existing raw file'}`);
  console.log(`- notes: ${notesResult}`);
  console.log('- registry: JSON and CSV synchronized');
  console.log('- report: Manual Collection section appended');
}

function parseArguments(args) {
  const options = { id: '', file: '', url: '', force: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--force') {
      options.force = true;
      continue;
    }
    if (['--id', '--file', '--url'].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} 后必须提供值。`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  for (const field of ['id', 'file', 'url']) {
    if (!options[field]) throw new Error(`缺少必填参数 --${field}。`);
  }
  return options;
}

function validateOfficialUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`--url 不是有效 URL：${value}`);
  }
  if (parsed.protocol !== 'https:') throw new Error('--url 必须以 https:// 开头。');
  const hostname = parsed.hostname.toLowerCase();
  const allowed = [...officialDomains].some((domain) =>
    hostname === domain || hostname.endsWith(`.${domain}`),
  );
  if (!allowed) throw new Error(`--url 域名不在官方白名单：${hostname}`);
  return parsed.toString();
}

async function validateInputFile(filePath) {
  const absolute = path.resolve(projectRoot, filePath);
  let fileStat;
  try {
    fileStat = await stat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`本地文件不存在：${filePath}。请先用浏览器保存官方资料后再补录。`);
    }
    throw new Error(`无法检查本地文件 ${filePath}：${error.message}`);
  }
  if (!fileStat.isFile()) throw new Error(`--file 必须指向文件：${filePath}`);
  const extension = path.extname(absolute).toLowerCase();
  if (!supportedExtensions.has(extension)) {
    throw new Error(`不支持的文件扩展名 ${extension || '(none)'}；仅支持 .pdf、.html、.htm、.txt。`);
  }
  return { absolute, extension };
}

async function loadRegistry() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(registryJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 source_registry.json：${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('source_registry.json 顶层必须是数组。');
  return parsed;
}

async function placeFile(inputFile, record, sourceId) {
  if (isInside(rawRoot, inputFile.absolute)) {
    return { absolute: inputFile.absolute, relative: toProjectPath(inputFile.absolute), copied: false };
  }
  if (typeof record.file_path !== 'string' || !record.file_path.trim()) {
    throw new Error(`source_id=${sourceId} 的 registry file_path 为空。`);
  }

  const registeredAbsolute = path.resolve(projectRoot, record.file_path);
  const registeredExtension = path.extname(registeredAbsolute).toLowerCase();
  const parsed = path.parse(registeredAbsolute);
  const baseName = parsed.name || sourceId;
  const finalExtension = supportedExtensions.has(registeredExtension)
    && registeredExtension === inputFile.extension
    ? registeredExtension
    : inputFile.extension;
  const destination = path.join(parsed.dir, `${baseName}${finalExtension}`);
  if (!isInside(rawRoot, destination)) {
    throw new Error(`registry file_path 必须位于 knowledge_sources/raw/：${record.file_path}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(inputFile.absolute, destination);
  return { absolute: destination, relative: toProjectPath(destination), copied: true };
}

async function syncRegistry(records) {
  await writeFile(registryJsonPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  const csvLines = [csvFields.join(',')];
  for (const record of records) {
    csvLines.push(csvFields.map((field) => escapeCsvValue(record[field])).join(','));
  }
  await writeFile(registryCsvPath, `${csvLines.join('\n')}\n`, 'utf8');
}

function escapeCsvValue(value) {
  const normalized = Array.isArray(value) ? value.join('|') : String(value ?? '');
  if (/[",\r\n]/.test(normalized)) return `"${normalized.replaceAll('"', '""')}"`;
  return normalized;
}

async function appendManualReport(entry) {
  let existing = '';
  try {
    existing = await readFile(reportPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!existing) {
    await writeFile(reportPath, '# Knowledge Sources Collection Report\n', 'utf8');
  }
  const section = `\n## Manual Collection\n\n- date: ${entry.date}\n- source_id: ${entry.source_id}\n- url: ${entry.url}\n- file_path: ${entry.file_path}\n- previous_status: ${entry.previous_status}\n- new_status: ${entry.new_status}\n- mode: manual\n`;
  await appendFile(reportPath, section, 'utf8');
}

async function ensureNotesSection(record) {
  const category = getCategory(record.file_path);
  const notesFileName = notesFiles[category];
  if (!notesFileName) return 'category not found; no notes section added';
  const notesPath = path.join(notesRoot, notesFileName);
  let existing = '';
  try {
    existing = await readFile(notesPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(record.source_id)}\\s*$`, 'm');
  if (headingPattern.test(existing)) return 'existing section preserved';

  const skeleton = `\n## ${record.source_id}\n\n资料名称：${record.title || ''}\n机构/作者：${record.organization || ''}\n年份：${record.year || ''}\n链接：${record.url || ''}\n保存位置：${record.file_path || ''}\n\n### 核心内容\n待人工阅读原文后填写。\n\n### 可用于项目\n- \n\n### 可抽取的知识点\n- \n\n### 使用边界\n- 不用于诊断\n- 不替代专业治疗\n- 高风险情况需要转入安全回应\n- 需要专业人员复核\n\n### 复核状态\ncollected\n`;
  await mkdir(path.dirname(notesPath), { recursive: true });
  await writeFile(notesPath, `${existing.trimEnd()}${skeleton}`, 'utf8');
  return `section appended to ${toProjectPath(notesPath)}`;
}

function getCategory(filePath) {
  const normalized = String(filePath || '').replaceAll('\\', '/');
  return Object.keys(notesFiles).find((category) => normalized.includes(`/raw/${category}/`)) || null;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function currentDate() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function toProjectPath(absolutePath) {
  return path.relative(projectRoot, absolutePath).replaceAll('\\', '/');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
