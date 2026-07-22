import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const knowledgeRoot = path.join(projectRoot, 'server', 'knowledge');
const reviewStatuses = [
  'unreviewed',
  'reviewed_by_self',
  'reviewed_by_psychology_student',
  'reviewed_by_professional',
];
const promisePhrases = [
  '治愈',
  '保证有效',
  '一定有效',
  '治疗方案',
  '解决你的心理问题',
  '诊断',
  '用药',
];
const userFacingInterventionFields = [
  'name',
  'suitable_for',
  'instruction',
  'natural_prompt',
  'example',
];

async function main() {
  const report = await auditKnowledge();
  printReport(report);
  if (report.errors.length > 0) process.exitCode = 1;
}

export async function auditKnowledge() {
  const errors = [];
  const warnings = [];
  const issueTypes = await loadEntityDirectory('issue_types', 'issue_types', errors);
  const mechanisms = await loadEntityDirectory('mechanisms', 'mechanisms', errors);
  const interventions = await loadEntityDirectory('interventions', 'interventions', errors);
  const safety = await loadSafetyEntries(errors);
  const sourceRegistry = await loadSourceRegistry(errors);
  const entries = [...issueTypes, ...mechanisms, ...interventions, ...safety.entries];

  const reviewDistribution = Object.fromEntries(reviewStatuses.map((status) => [status, 0]));
  const sourceLevelDistribution = new Map();
  const nonStandardReviewStatuses = new Map();

  for (const entry of entries) {
    const rawStatus = entry.value.review_status;
    if (typeof rawStatus !== 'string' || !rawStatus.trim()) {
      errors.push(problem('ERROR', entry.path, '缺少 review_status。'));
    } else {
      const normalizedStatus = normalizeReviewStatus(rawStatus);
      reviewDistribution[normalizedStatus] += 1;
      if (!reviewStatuses.includes(rawStatus)) {
        nonStandardReviewStatuses.set(rawStatus, (nonStandardReviewStatuses.get(rawStatus) || 0) + 1);
      }
    }

    const sourceLevel = entry.value.source_level;
    if (typeof sourceLevel !== 'string' || !sourceLevel.trim()) {
      errors.push(problem('ERROR', entry.path, '缺少 source_level。'));
    } else {
      sourceLevelDistribution.set(sourceLevel, (sourceLevelDistribution.get(sourceLevel) || 0) + 1);
    }
  }

  if (nonStandardReviewStatuses.size > 0) {
    const detail = [...nonStandardReviewStatuses.entries()]
      .map(([status, count]) => `${status}=${count}`)
      .join(', ');
    warnings.push(problem(
      'WARN',
      'review_status',
      `发现尚未进入标准审校状态流的值（${detail}），本次按 unreviewed 统计。`,
    ));
  }
  if (reviewDistribution.unreviewed > 0) {
    const ratio = entries.length ? reviewDistribution.unreviewed / entries.length : 0;
    warnings.push(problem(
      'WARN',
      'review_status',
      `${reviewDistribution.unreviewed}/${entries.length} 条（${formatPercent(ratio)}）仍为 unreviewed；这不会单独导致审校失败。`,
    ));
  }

  const sourceReferences = [];
  let entriesWithSourceReferences = 0;
  for (const entry of entries) {
    const entrySourceReferences = extractSourceReferences(entry.value);
    if (entrySourceReferences.length > 0) entriesWithSourceReferences += 1;
    for (const sourceId of entrySourceReferences) {
      sourceReferences.push({ sourceId, path: entry.path });
      if (!sourceRegistry.ids.has(sourceId)) {
        errors.push(problem('ERROR', entry.path, `引用了未登记的 source id：${sourceId}。`));
      }
    }
  }
  const entriesWithoutSourceReferences = entries.length - entriesWithSourceReferences;
  if (entriesWithoutSourceReferences > 0) {
    warnings.push(problem(
      'WARN',
      'source_refs',
      `${entriesWithoutSourceReferences}/${entries.length} 条运行时知识没有明确来源引用；扩充前应优先补齐可追溯性。`,
    ));
  }

  auditAssociations(issueTypes, mechanisms, errors);
  auditInterventions(interventions, errors);
  auditSafety(safety, errors);

  return {
    counts: {
      totalEntries: entries.length,
      issueTypes: issueTypes.length,
      mechanisms: mechanisms.length,
      interventions: interventions.length,
      safetyLevels: safety.levels.length,
      safetyDocuments: safety.documents.length,
      registeredSources: sourceRegistry.ids.size,
      sourceReferences: sourceReferences.length,
      entriesWithSourceReferences,
      entriesWithoutSourceReferences,
    },
    reviewDistribution,
    sourceLevelDistribution: Object.fromEntries(
      [...sourceLevelDistribution.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    errors,
    warnings,
  };
}

async function loadEntityDirectory(directoryName, arrayKey, errors) {
  const directory = path.join(knowledgeRoot, directoryName);
  let fileNames;
  try {
    fileNames = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    errors.push(problem('ERROR', relativePath(directory), `无法扫描目录：${error.message}`));
    return [];
  }

  const entries = [];
  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    const document = await readJson(filePath, errors);
    if (document === null) continue;
    let values;
    if (Array.isArray(document)) values = document;
    else if (document && typeof document === 'object' && typeof document.id === 'string') values = [document];
    else if (Array.isArray(document?.[arrayKey])) values = document[arrayKey];
    else {
      errors.push(problem('ERROR', relativePath(filePath), '必须包含单个条目或条目数组。'));
      continue;
    }
    values.forEach((value, index) => {
      const id = typeof value?.id === 'string' ? value.id : `item_${index + 1}`;
      entries.push({ value, path: `${relativePath(filePath)}#${id}` });
    });
  }
  return entries;
}

async function loadSafetyEntries(errors) {
  const safetyDirectory = path.join(knowledgeRoot, 'safety');
  let fileNames;
  try {
    fileNames = (await readdir(safetyDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    errors.push(problem('ERROR', relativePath(safetyDirectory), `无法扫描目录：${error.message}`));
    return { entries: [], levels: [], documents: [], crisisResponse: null };
  }

  const entries = [];
  const levels = [];
  const documents = [];
  let crisisResponse = null;
  for (const fileName of fileNames) {
    const filePath = path.join(safetyDirectory, fileName);
    const document = await readJson(filePath, errors);
    if (document === null) continue;
    if (Array.isArray(document.risk_levels)) {
      for (const [index, level] of document.risk_levels.entries()) {
        const value = {
          ...level,
          review_status: level.review_status ?? document.review_status,
          source_level: level.source_level ?? document.source_level,
        };
        const id = typeof level.id === 'string' ? level.id : `level_${index}`;
        const entry = { value, path: `${relativePath(filePath)}#${id}` };
        entries.push(entry);
        levels.push(entry);
      }
      continue;
    }
    if (document.templates && typeof document.templates === 'object') {
      const entry = {
        value: { ...document, id: document.id || 'crisis_response' },
        path: `${relativePath(filePath)}#crisis_response`,
      };
      entries.push(entry);
      documents.push(entry);
      crisisResponse = document;
      continue;
    }
    errors.push(problem('ERROR', relativePath(filePath), '无法识别 safety JSON 结构。'));
  }
  return { entries, levels, documents, crisisResponse };
}

async function loadSourceRegistry(errors) {
  const filePath = path.join(knowledgeRoot, 'source_registry.json');
  const document = await readJson(filePath, errors);
  const sources = document?.sources;
  if (!Array.isArray(sources)) {
    errors.push(problem('ERROR', relativePath(filePath), '缺少 sources 数组。'));
    return { ids: new Set() };
  }
  const ids = new Set();
  for (const [index, source] of sources.entries()) {
    if (typeof source?.id !== 'string' || !source.id.trim()) {
      errors.push(problem('ERROR', `${relativePath(filePath)}#${index + 1}`, '来源缺少有效 id。'));
    } else if (ids.has(source.id)) {
      errors.push(problem('ERROR', relativePath(filePath), `来源 id 重复：${source.id}。`));
    } else {
      ids.add(source.id);
    }
  }
  return { ids };
}

function auditAssociations(issueTypes, mechanisms, errors) {
  const issueIds = new Set(issueTypes.map((entry) => entry.value.id));
  const mechanismIds = new Set(mechanisms.map((entry) => entry.value.id));
  for (const entry of issueTypes) {
    const related = entry.value.common_mechanisms;
    if (!Array.isArray(related) || related.length === 0) {
      errors.push(problem('ERROR', entry.path, 'issue_type 至少需要关联一个 common_mechanisms。'));
      continue;
    }
    for (const mechanismId of related) {
      if (!mechanismIds.has(mechanismId)) {
        errors.push(problem('ERROR', entry.path, `关联了不存在的 mechanism：${mechanismId}。`));
      }
    }
  }
  for (const entry of mechanisms) {
    const related = entry.value.related_issue_types;
    if (!Array.isArray(related) || related.length === 0) {
      errors.push(problem('ERROR', entry.path, 'mechanism 至少需要关联一个 related_issue_types。'));
      continue;
    }
    for (const issueId of related) {
      if (!issueIds.has(issueId)) {
        errors.push(problem('ERROR', entry.path, `关联了不存在的 issue_type：${issueId}。`));
      }
    }
  }
}

function auditInterventions(interventions, errors) {
  for (const entry of interventions) {
    for (const field of userFacingInterventionFields) {
      for (const text of flattenStrings(entry.value[field])) {
        for (const phrase of promisePhrases) {
          let index = text.indexOf(phrase);
          while (index >= 0) {
            if (!isNegatedPromise(text, index)) {
              errors.push(problem('ERROR', `${entry.path}.${field}`, `发现治疗承诺或医疗越界表达：“${phrase}”。`));
            }
            index = text.indexOf(phrase, index + phrase.length);
          }
        }
      }
    }
  }
}

function auditSafety(safety, errors) {
  const levelMap = new Map(safety.levels.map((entry) => [entry.value.id, entry]));
  const templates = safety.crisisResponse?.templates || {};
  const requirements = [
    ['确认立即危险', /(立即危险|即刻危险|当前安全|现在.{0,12}(?:计划|工具|安全)|具体计划|方式、时间、地点|正在实施|无法保证.{0,8}安全)/],
    ['联系可信任的人', /(可信任|能.{0,6}到场|附近的人|不要独处|陪你|可到场支持)/],
    ['紧急服务 / 医院 / 热线', /(紧急服务|紧急电话|医院|急诊|危机热线|热线|110|120)/],
    ['远离危险物品', /(危险物|工具.{0,8}(?:交给|远离|保管)|远离.{0,8}(?:物品|工具)|交出.{0,8}(?:物品|工具))/],
  ];
  for (const levelId of ['level_2', 'level_3', 'level_4']) {
    const entry = levelMap.get(levelId);
    if (!entry) {
      errors.push(problem('ERROR', 'safety/risk_levels.json', `缺少 ${levelId}。`));
      continue;
    }
    const combined = `${JSON.stringify(entry.value)}\n${templates[levelId] || ''}`;
    for (const [label, pattern] of requirements) {
      if (!pattern.test(combined)) {
        errors.push(problem('ERROR', entry.path, `${levelId} 缺少安全要素：${label}。`));
      }
    }
  }
}

function extractSourceReferences(value) {
  const refs = [];
  for (const key of ['source_id', 'source_ids', 'source_refs']) {
    const raw = value?.[key];
    if (typeof raw === 'string') refs.push(raw);
    else if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'string') refs.push(item);
        else if (typeof item?.id === 'string') refs.push(item.id);
      }
    }
  }
  return [...new Set(refs.filter(Boolean))];
}

function normalizeReviewStatus(status) {
  if (reviewStatuses.includes(status)) return status;
  return 'unreviewed';
}

function isNegatedPromise(text, phraseIndex) {
  const prefix = text.slice(Math.max(0, phraseIndex - 12), phraseIndex);
  return /(?:不|不会|不能|不得|并非|不是|不作为|不提供|不承诺|避免|禁止).{0,6}$/.test(prefix);
}

function flattenStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  return [];
}

async function readJson(filePath, errors) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    errors.push(problem('ERROR', relativePath(filePath), `无法读取文件：${error.message}`));
    return null;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    errors.push(problem('ERROR', relativePath(filePath), `不是有效 JSON：${error.message}`));
    return null;
  }
}

function printReport(report) {
  console.log('Knowledge Base 2.0 Audit');
  console.log('='.repeat(72));
  console.log('范围：server/knowledge/{issue_types,mechanisms,interventions,safety}');
  console.log('模式：只读检查，不修改知识库内容');
  console.log('');
  console.log('条目统计');
  console.log(`- 总条目数: ${report.counts.totalEntries}`);
  console.log(`- issue_types: ${report.counts.issueTypes}`);
  console.log(`- mechanisms: ${report.counts.mechanisms}`);
  console.log(`- interventions: ${report.counts.interventions}`);
  console.log(`- safety levels: ${report.counts.safetyLevels}`);
  console.log(`- safety documents: ${report.counts.safetyDocuments}`);
  console.log(`- registered sources: ${report.counts.registeredSources}`);
  console.log(`- checked source references: ${report.counts.sourceReferences}`);
  console.log(`- entries with source references: ${report.counts.entriesWithSourceReferences}`);
  console.log(`- entries without source references: ${report.counts.entriesWithoutSourceReferences}`);
  console.log('');
  console.log('review_status 分布');
  for (const status of reviewStatuses) console.log(`- ${status}: ${report.reviewDistribution[status]}`);
  console.log('');
  console.log('source_level 分布');
  for (const [level, count] of Object.entries(report.sourceLevelDistribution)) {
    console.log(`- ${level}: ${count}`);
  }
  console.log('');
  console.log('发现的问题');
  if (report.errors.length === 0 && report.warnings.length === 0) {
    console.log('- 无');
  } else {
    for (const item of [...report.errors, ...report.warnings]) {
      console.log(`- [${item.severity}] ${item.path}: ${item.message}`);
    }
  }
  console.log('');
  if (report.errors.length > 0) {
    console.log(`结果：FAIL（${report.errors.length} ERROR, ${report.warnings.length} WARN）`);
  } else if (report.warnings.length > 0) {
    console.log(`结果：PASS WITH WARNINGS（0 ERROR, ${report.warnings.length} WARN）`);
  } else {
    console.log('结果：PASS（0 ERROR, 0 WARN）');
  }
}

function problem(severity, itemPath, message) {
  return { severity, path: itemPath, message };
}

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).replaceAll('\\', '/');
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(`Knowledge audit failed unexpectedly: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

function isDirectExecution() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
