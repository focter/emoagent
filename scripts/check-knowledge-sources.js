import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const registryDirectory = path.join(projectRoot, 'knowledge_sources', 'registry');
const jsonPath = path.join(registryDirectory, 'source_registry.json');
const csvPath = path.join(registryDirectory, 'source_registry.csv');
const requiredFields = [
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
const allowedStatuses = [
  'todo',
  'collected',
  'summarized',
  'needs_review',
  'approved',
  'deprecated',
];
const allowedStatusSet = new Set(allowedStatuses);
const allowedNotesDone = new Set(['yes', 'no']);
const categoryPaths = [
  'raw/safety/',
  'raw/self_help/',
  'raw/common_issues/',
  'raw/methods/',
  'raw/student_mental_health/',
  'raw/ai_ethics_privacy/',
  'raw/workplace_mental_health/',
];
const errors = [];
const warnings = [];
const jsonSourceIds = new Set();
const csvSourceIds = new Set();
let records = [];
let csvIdsAvailable = false;

loadAndValidateJson();
loadAndValidateCsv();
compareSourceIdSets();
const summary = buildSummary(records);
const categoryCounts = buildCategoryCounts(records);
for (const categoryPath of categoryPaths) {
  if (categoryCounts[categoryPath] === 0) {
    warnings.push(`${categoryPath} 没有登记任何资料。`);
  }
}
printResult(summary, categoryCounts);

function loadAndValidateJson() {
  if (!existsSync(jsonPath)) {
    errors.push(formatError('registry', 'source_registry.json', '文件不存在'));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    errors.push(formatError('registry', 'source_registry.json', `不是有效 JSON：${error.message}`));
    return;
  }
  if (!Array.isArray(parsed)) {
    errors.push(formatError('registry', 'source_registry.json', '顶层必须是数组'));
    return;
  }
  records = parsed;

  records.forEach((record, index) => {
    const fallbackId = `record_${index + 1}`;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push(formatError(fallbackId, 'record', '记录必须是对象'));
      return;
    }

    const sourceId = typeof record.source_id === 'string' && record.source_id.trim()
      ? record.source_id.trim()
      : fallbackId;
    for (const field of requiredFields) {
      if (!Object.hasOwn(record, field)) {
        errors.push(formatError(sourceId, field, '缺少必填字段'));
      }
    }

    if (typeof record.source_id !== 'string' || !record.source_id.trim()) {
      errors.push(formatError(sourceId, 'source_id', '必须是非空字符串'));
    } else if (jsonSourceIds.has(sourceId)) {
      errors.push(formatError(sourceId, 'source_id', 'source_id 重复'));
    } else {
      jsonSourceIds.add(sourceId);
    }

    if (typeof record.file_path !== 'string' || !record.file_path.trim()) {
      errors.push(formatError(sourceId, 'file_path', '必须填写保存路径'));
    }
    if (!allowedStatusSet.has(record.status)) {
      errors.push(formatError(sourceId, 'status', `非法值：${String(record.status)}`));
    }
    if (!allowedNotesDone.has(record.notes_done)) {
      errors.push(formatError(sourceId, 'notes_done', `非法值：${String(record.notes_done)}`));
    }
    if (record.status === 'summarized' && record.notes_done !== 'yes') {
      errors.push(formatError(sourceId, 'notes_done', 'status=summarized 时必须为 yes'));
    }
    if (record.status === 'approved' && record.notes_done !== 'yes') {
      errors.push(formatError(sourceId, 'notes_done', 'status=approved 时必须为 yes'));
    }
    if (record.status === 'todo' && record.notes_done !== 'no') {
      errors.push(formatError(sourceId, 'notes_done', 'status=todo 时必须为 no'));
    }
  });
}

function loadAndValidateCsv() {
  if (!existsSync(csvPath)) {
    errors.push(formatError('registry', 'source_registry.csv', '文件不存在'));
    return;
  }

  let rows;
  try {
    rows = parseCsv(readFileSync(csvPath, 'utf8'));
  } catch (error) {
    errors.push(formatError('registry', 'source_registry.csv', `无法解析：${error.message}`));
    return;
  }
  if (rows.length === 0) {
    errors.push(formatError('registry', 'source_registry.csv', '缺少表头'));
    return;
  }

  const headers = rows[0].map((header, index) => {
    const value = String(header).trim();
    return index === 0 ? value.replace(/^\uFEFF/, '') : value;
  });
  for (const field of requiredFields) {
    if (!headers.includes(field)) {
      errors.push(formatError('registry', field, 'CSV 表头缺少字段'));
    }
  }

  const sourceIdIndex = headers.indexOf('source_id');
  if (sourceIdIndex < 0) return;
  csvIdsAvailable = true;
  rows.slice(1).forEach((row, index) => {
    if (row.every((value) => !String(value).trim())) return;
    const sourceId = String(row[sourceIdIndex] || '').trim();
    if (!sourceId) {
      errors.push(formatError(`csv_row_${index + 2}`, 'source_id', '必须是非空字符串'));
    } else if (csvSourceIds.has(sourceId)) {
      errors.push(formatError(sourceId, 'source_id', 'CSV 中 source_id 重复'));
    } else {
      csvSourceIds.add(sourceId);
    }
  });
}

function compareSourceIdSets() {
  if (!csvIdsAvailable || !Array.isArray(records)) return;
  const missingFromCsv = [...jsonSourceIds].filter((id) => !csvSourceIds.has(id)).sort();
  const extraInCsv = [...csvSourceIds].filter((id) => !jsonSourceIds.has(id)).sort();
  if (missingFromCsv.length > 0) {
    errors.push(formatError('registry', 'source_id', `JSON 中存在但 CSV 缺失：${missingFromCsv.join(', ')}`));
  }
  if (extraInCsv.length > 0) {
    errors.push(formatError('registry', 'source_id', `CSV 中存在但 JSON 缺失：${extraInCsv.join(', ')}`));
  }
}

function buildSummary(sourceRecords) {
  const statusCounts = Object.fromEntries(allowedStatuses.map((status) => [status, 0]));
  let notesDoneYes = 0;
  let notesDoneNo = 0;
  for (const record of sourceRecords) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    if (allowedStatusSet.has(record.status)) statusCounts[record.status] += 1;
    if (record.notes_done === 'yes') notesDoneYes += 1;
    if (record.notes_done === 'no') notesDoneNo += 1;
  }
  return {
    total: sourceRecords.length,
    ...statusCounts,
    notes_done_yes: notesDoneYes,
    notes_done_no: notesDoneNo,
  };
}

function buildCategoryCounts(sourceRecords) {
  const counts = Object.fromEntries(categoryPaths.map((categoryPath) => [categoryPath, 0]));
  for (const record of sourceRecords) {
    if (typeof record?.file_path !== 'string') continue;
    const normalizedPath = record.file_path.replaceAll('\\', '/');
    for (const categoryPath of categoryPaths) {
      if (normalizedPath.includes(categoryPath)) counts[categoryPath] += 1;
    }
  }
  return counts;
}

function printResult(summary, categoryCounts) {
  console.log('Knowledge sources summary:');
  console.log(`- total: ${summary.total}`);
  for (const status of allowedStatuses) console.log(`- ${status}: ${summary[status]}`);
  console.log(`- notes_done_yes: ${summary.notes_done_yes}`);
  console.log(`- notes_done_no: ${summary.notes_done_no}`);
  console.log('');
  console.log('Knowledge sources category coverage:');
  for (const categoryPath of categoryPaths) {
    console.log(`- ${categoryPath}: ${categoryCounts[categoryPath]}`);
  }

  if (warnings.length > 0) {
    console.warn('');
    console.warn('Knowledge sources warnings:');
    for (const warning of warnings) console.warn(`- ${warning}`);
  }
  if (errors.length > 0) {
    console.error('');
    console.error('Knowledge sources check failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('CSV registry detected; source_registry.csv is for manual maintenance and is not strictly field-compared with JSON.');
  console.log('Knowledge sources check passed.');
}

function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inQuotes) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (inQuotes) throw new Error('存在未闭合的双引号');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => String(value).trim()));
}

function formatError(sourceId, field, message) {
  return `[${sourceId}] ${field}: ${message}`;
}
