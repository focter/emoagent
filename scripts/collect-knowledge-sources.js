import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const registryDirectory = path.join(projectRoot, 'knowledge_sources', 'registry');
const registryJsonPath = path.join(registryDirectory, 'source_registry.json');
const registryCsvPath = path.join(registryDirectory, 'source_registry.csv');
const reportPath = path.join(registryDirectory, 'collection_report.md');
const rawRoot = path.join(projectRoot, 'knowledge_sources', 'raw');
const notesRoot = path.join(projectRoot, 'knowledge_sources', 'notes');
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
const officialUrls = {
  who_safety_planning: 'https://www.who.int/teams/mental-health-and-substance-use/treatment-care/mental-health-gap-action-programme/evidence-centre/self-harm-and-suicide/safety-planning-interventions',
  who_mhgap_self_harm_suicide: 'https://www.who.int/teams/mental-health-and-substance-use/treatment-care/mental-health-gap-action-programme/evidence-centre/self-harm-and-suicide',
  nhc_hotline_guide: 'https://www.nhc.gov.cn/wjw/c100175/202101/ce4756ac40e742a48b00ff32d3807825.shtml',
  nhc_12356: 'https://www.nhc.gov.cn/yzygj/c100068/202412/49a1a65386cd4be582d4702fd0926ee8.shtml',
  who_self_help_interventions: 'https://www.who.int/news/item/01-06-2026-who-launches-new-guide-to-help-scale-psychological-self-help',
  who_doing_what_matters: 'https://www.who.int/publications/i/item/9789240003927',
  nimh_self_care: 'https://www.nimh.nih.gov/health/topics/caring-for-your-mental-health',
  nhs_guided_self_help: 'https://www.england.nhs.uk/mental-health/adults/nhs-talking-therapies/',
  nice_depression_ng222: 'https://www.nice.org.uk/guidance/ng222',
  nice_anxiety_cg113: 'https://www.nice.org.uk/guidance/cg113',
  nhs_cbt: 'https://www.nhs.uk/tests-and-treatments/cognitive-behavioural-therapy-cbt/',
  nimh_psychotherapies: 'https://www.nimh.nih.gov/health/topics/psychotherapies',
  moe_student_mental_health_2023_2025: 'https://www.moe.gov.cn/srcsite/A17/moe_943/moe_946/202305/t20230511_1059219.html',
  who_ai_health_ethics: 'https://www.who.int/publications/i/item/9789240029200',
  apa_app_evaluation_model: 'https://www.psychiatry.org/psychiatrists/practice/mental-health-apps/the-app-evaluation-model',
  who_mental_health_at_work_guideline: 'https://www.who.int/publications/i/item/9789240053052',
  nice_workplace_wellbeing_ng212: 'https://www.nice.org.uk/guidance/ng212/resources/mental-wellbeing-at-work-pdf-66143771841733',
  nice_social_anxiety_cg159: 'https://www.nice.org.uk/guidance/cg159/resources/social-anxiety-disorder-recognition-assessment-and-treatment-pdf-35109639699397',
  nhs_grief_bereavement_loss: 'https://www.nhs.uk/mental-health/feelings-symptoms-behaviours/feelings-and-symptoms/grief-bereavement-loss/',
};
const notesFiles = {
  safety: 'safety_notes.md',
  self_help: 'self_help_notes.md',
  common_issues: 'common_issues_notes.md',
  methods: 'methods_notes.md',
  student_mental_health: 'student_notes.md',
  ai_ethics_privacy: 'ai_ethics_notes.md',
  workplace_mental_health: 'workplace_notes.md',
};

main().catch((error) => {
  console.error(`Knowledge source collection failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node.js 不支持全局 fetch。请使用 Node.js 18 或更高版本。');
  }
  const options = parseArguments(process.argv.slice(2));
  const records = await loadRegistry();
  const selectedRecords = options.id
    ? records.filter((record) => record.source_id === options.id)
    : records;
  if (options.id && selectedRecords.length === 0) {
    throw new Error(`source_id 不存在：${options.id}`);
  }

  const results = { collected: [], failed: [], skipped: [] };
  for (const record of selectedRecords) {
    const decision = prepareCollection(record, options);
    if (decision.skipReason) {
      results.skipped.push({ source_id: record.source_id, reason: decision.skipReason });
      console.log(`[SKIPPED] ${record.source_id}: ${decision.skipReason}`);
      continue;
    }
    if (options.dryRun) {
      console.log(`[DRY RUN] ${record.source_id}`);
      console.log(`  url: ${decision.url}`);
      console.log(`  target: ${record.file_path}`);
      console.log('  update: url, file_path (按 content-type 调整), status=collected, access_date');
      continue;
    }

    const result = await collectOne(record, decision.url);
    if (result.ok) {
      record.url = result.url;
      record.file_path = result.file_path;
      record.status = 'collected';
      record.access_date = currentDate();
      if (!record.notes_done) record.notes_done = 'no';
      results.collected.push({
        source_id: record.source_id,
        url: result.url,
        file_path: result.file_path,
        content_type: result.content_type,
        warnings: result.warnings,
      });
      console.log(`[COLLECTED] ${record.source_id} -> ${result.file_path}`);
      for (const warning of result.warnings) console.warn(`[WARN] ${record.source_id}: ${warning}`);
      await ensureNotesSection(record);
    } else {
      results.failed.push({ source_id: record.source_id, url: decision.url, reason: result.reason });
      console.error(`[FAILED] ${record.source_id}: ${result.reason}`);
    }
  }

  if (options.dryRun) {
    console.log(`\nDry run complete. Planned: ${selectedRecords.length - results.skipped.length}, skipped: ${results.skipped.length}. No files were written.`);
    return;
  }

  if (results.collected.length > 0) {
    await syncRegistry(records);
  }
  await writeCollectionReport(selectedRecords.length, results);
  console.log('');
  console.log('Knowledge sources collection summary:');
  console.log(`- total: ${selectedRecords.length}`);
  console.log(`- collected: ${results.collected.length}`);
  console.log(`- failed: ${results.failed.length}`);
  console.log(`- skipped: ${results.skipped.length}`);
  console.log(`- report: ${toProjectPath(reportPath)}`);
}

function parseArguments(args) {
  const options = { id: null, dryRun: false, force: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--id') {
      const sourceId = args[index + 1];
      if (!sourceId || sourceId.startsWith('--')) throw new Error('--id 后必须提供 source_id。');
      options.id = sourceId;
      index += 1;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
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

function prepareCollection(record, options) {
  if (!record || typeof record !== 'object' || !record.source_id) {
    return { skipReason: '记录缺少 source_id。' };
  }
  if (record.status === 'approved') return { skipReason: 'approved 状态只能人工维护，不自动重新下载。' };
  if (record.status === 'deprecated') return { skipReason: '记录已 deprecated。' };
  if (record.status === 'needs_review') return { skipReason: '记录正在人工复核，不自动覆盖。' };
  if (!options.force && ['collected', 'summarized'].includes(record.status)) {
    return { skipReason: `status=${record.status}；使用 --force 才会重新下载。` };
  }

  const url = String(record.url || officialUrls[record.source_id] || '').trim();
  if (!url) return { skipReason: '没有现有 URL，也没有内置官方 URL 映射。' };
  const validation = validateOfficialUrl(url);
  if (!validation.ok) return { skipReason: validation.reason };
  if (typeof record.file_path !== 'string' || !record.file_path.trim()) {
    return { skipReason: 'file_path 为空。' };
  }
  return { url };
}

async function collectOne(record, requestedUrl) {
  try {
    const response = await fetch(requestedUrl, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/pdf;q=0.9,*/*;q=0.5',
        'User-Agent': 'emoagent-knowledge-source-collector/1.0',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };

    const finalUrl = response.url || requestedUrl;
    const finalValidation = validateOfficialUrl(finalUrl);
    if (!finalValidation.ok) {
      return { ok: false, reason: `重定向后的 URL 不在官方白名单：${finalUrl}` };
    }

    const contentType = normalizeContentType(response.headers.get('content-type'));
    const format = getFormat(contentType);
    const target = resolveTargetPath(record.file_path, format.extension);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) return { ok: false, reason: '响应内容为空。' };
    await mkdir(path.dirname(target.absolute), { recursive: true });
    await writeFile(target.absolute, data);

    const warnings = [];
    if (format.warning) warnings.push(format.warning);
    return {
      ok: true,
      url: finalUrl,
      file_path: target.relative,
      content_type: contentType || 'unknown',
      warnings,
    };
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? '请求超时（30 秒）。'
      : error.message;
    return { ok: false, reason };
  }
}

function validateOfficialUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: `URL 无效：${value}` };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: '只允许 HTTPS 官方 URL。' };
  const hostname = parsed.hostname.toLowerCase();
  const allowed = [...officialDomains].some((domain) =>
    hostname === domain || hostname.endsWith(`.${domain}`),
  );
  return allowed
    ? { ok: true }
    : { ok: false, reason: `域名不在官方白名单：${hostname}` };
}

function normalizeContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function getFormat(contentType) {
  if (contentType === 'application/pdf') return { extension: '.pdf', warning: null };
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    return { extension: '.html', warning: null };
  }
  return {
    extension: '.bin',
    warning: `content-type=${contentType || 'unknown'}，按 .bin 保存。`,
  };
}

function resolveTargetPath(filePath, desiredExtension) {
  const originalAbsolute = path.resolve(projectRoot, filePath);
  const parsed = path.parse(originalAbsolute);
  const absolute = path.join(parsed.dir, `${parsed.name || 'source'}${desiredExtension}`);
  const relativeToRaw = path.relative(rawRoot, absolute);
  if (relativeToRaw.startsWith('..') || path.isAbsolute(relativeToRaw)) {
    throw new Error(`file_path 必须位于 knowledge_sources/raw/：${filePath}`);
  }
  return { absolute, relative: toProjectPath(absolute) };
}

async function syncRegistry(records) {
  await writeFile(registryJsonPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  const lines = [csvFields.join(',')];
  for (const record of records) {
    lines.push(csvFields.map((field) => escapeCsvValue(record[field])).join(','));
  }
  await writeFile(registryCsvPath, `${lines.join('\n')}\n`, 'utf8');
}

function escapeCsvValue(value) {
  const normalized = Array.isArray(value) ? value.join('|') : String(value ?? '');
  if (/[",\r\n]/.test(normalized)) return `"${normalized.replaceAll('"', '""')}"`;
  return normalized;
}

async function ensureNotesSection(record) {
  const category = getCategory(record.file_path);
  const notesFileName = notesFiles[category];
  if (!notesFileName) {
    console.warn(`[WARN] ${record.source_id}: 无法从 file_path 确定 notes 分类。`);
    return;
  }
  const notesPath = path.join(notesRoot, notesFileName);
  let existing = '';
  try {
    existing = await readFile(notesPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(record.source_id)}\\s*$`, 'm');
  if (headingPattern.test(existing)) return;

  const skeleton = `\n## ${record.source_id}\n\n资料名称：${record.title || ''}\n机构/作者：${record.organization || ''}\n年份：${record.year || ''}\n链接：${record.url || ''}\n保存位置：${record.file_path || ''}\n\n### 核心内容\n\n待人工阅读原文后填写。\n\n### 可用于项目\n\n*\n\n### 可抽取的知识点\n\n*\n\n### 使用边界\n\n* 不用于诊断\n* 不替代专业治疗\n* 高风险情况需要转入安全回应\n* 需要专业人员复核\n\n### 复核状态\n\ncollected\n`;
  await mkdir(path.dirname(notesPath), { recursive: true });
  await writeFile(notesPath, `${existing.trimEnd()}${skeleton}`, 'utf8');
}

function getCategory(filePath) {
  const normalized = String(filePath || '').replaceAll('\\', '/');
  return Object.keys(notesFiles).find((category) => normalized.includes(`/raw/${category}/`)) || null;
}

async function writeCollectionReport(total, results) {
  const lines = [
    '# Knowledge Sources Collection Report',
    '',
    '## Summary',
    '',
    `* total: ${total}`,
    `* collected: ${results.collected.length}`,
    `* failed: ${results.failed.length}`,
    `* skipped: ${results.skipped.length}`,
    `* date: ${currentDate()}`,
    '',
    '## Collected',
    '',
  ];
  appendResultList(lines, results.collected, (item) => [
    `* \`${item.source_id}\``,
    `  * url: ${item.url}`,
    `  * file_path: ${item.file_path}`,
    `  * content_type: ${item.content_type}`,
    ...item.warnings.map((warning) => `  * warning: ${warning}`),
  ]);
  lines.push('', '## Failed', '');
  appendResultList(lines, results.failed, (item) => [
    `* \`${item.source_id}\``,
    `  * url: ${item.url}`,
    `  * reason: ${sanitizeReportText(item.reason)}`,
  ]);
  lines.push('', '## Skipped', '');
  appendResultList(lines, results.skipped, (item) => [
    `* \`${item.source_id}\``,
    `  * reason: ${sanitizeReportText(item.reason)}`,
  ]);
  lines.push(
    '',
    '## Manual Review Required',
    '',
    '* 自动下载不等于专业审核。',
    '* notes 仍需要人工摘要。',
    '* approved 状态必须人工确认。',
    '* 高风险安全资料必须由合格专业人员复核。',
    '',
  );
  await writeFile(reportPath, lines.join('\n'), 'utf8');
}

function appendResultList(lines, items, formatter) {
  if (items.length === 0) {
    lines.push('* None');
    return;
  }
  for (const item of items) lines.push(...formatter(item));
}

function sanitizeReportText(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ');
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}

function toProjectPath(absolutePath) {
  return path.relative(projectRoot, absolutePath).replaceAll('\\', '/');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
