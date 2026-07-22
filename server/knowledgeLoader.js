import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const knowledgeDirectory = path.join(__dirname, 'knowledge');

const REQUIRED_FIELDS = {
  issueTypes: [
    'id', 'name', 'description', 'user_expressions', 'key_dimensions', 'first_followups',
    'enough_information_signals', 'common_mechanisms', 'possible_interventions', 'do_not_say',
    'escalation_signals', 'source_level', 'review_status',
  ],
  mechanisms: [
    'id', 'name', 'use_when', 'do_not_use_when', 'plain_explanation',
    'natural_response_examples', 'safe_small_actions', 'avoid', 'related_issue_types',
    'related_interventions', 'source_level', 'review_status',
  ],
  interventions: [
    'id', 'name', 'suitable_for', 'not_suitable_for', 'instruction', 'natural_prompt',
    'example', 'avoid', 'safety_notes', 'source_level', 'review_status',
  ],
  safetyLevels: [
    'id', 'signals', 'response_goal', 'must_include', 'must_not_include', 'allowed_followups',
    'escalation_action',
  ],
  sources: ['id', 'title', 'source_type', 'url', 'usage_note', 'last_checked'],
};

const ARRAY_FIELDS = new Set([
  'user_expressions', 'key_dimensions', 'first_followups', 'enough_information_signals',
  'common_mechanisms', 'possible_interventions', 'do_not_say', 'escalation_signals',
  'use_when', 'do_not_use_when', 'natural_response_examples', 'safe_small_actions', 'avoid',
  'related_issue_types', 'related_interventions', 'suitable_for', 'not_suitable_for',
  'instruction', 'safety_notes', 'signals', 'must_include', 'must_not_include',
  'allowed_followups',
]);

let cachedKnowledge = null;
let cachedSignature = '';

export async function loadKnowledge({ forceReload = false } = {}) {
  const indexPath = path.join(knowledgeDirectory, 'index.json');
  const index = await readJson(indexPath);
  validateIndex(index, indexPath);

  const issueFiles = await listJsonFiles(index.collections.issueTypes.directory);
  const mechanismFiles = await listJsonFiles(index.collections.mechanisms.directory);
  const interventionFiles = await listJsonFiles(index.collections.interventions.directory);
  const fixedFiles = [
    indexPath,
    resolveKnowledgePath(index.collections.safetyLevels.file),
    resolveKnowledgePath(index.collections.crisisResponse.file),
    resolveKnowledgePath(index.collections.sourceRegistry.file),
    resolveKnowledgePath(index.legacy_support.questionStrategy),
    resolveKnowledgePath(index.legacy_support.responseRules),
  ];
  const allFiles = [...fixedFiles, ...issueFiles, ...mechanismFiles, ...interventionFiles];
  const signature = await getSignature(allFiles);

  if (!forceReload && cachedKnowledge && signature === cachedSignature) return cachedKnowledge;

  const [issueTypes, mechanisms, interventions, riskDocument, crisisResponse, sourceRegistry,
    questionStrategy, responseRules] = await Promise.all([
    loadCollection(issueFiles, 'issueTypes'),
    loadCollection(mechanismFiles, 'mechanisms'),
    loadCollection(interventionFiles, 'interventions'),
    readJson(resolveKnowledgePath(index.collections.safetyLevels.file)),
    readJson(resolveKnowledgePath(index.collections.crisisResponse.file)),
    readJson(resolveKnowledgePath(index.collections.sourceRegistry.file)),
    readJson(resolveKnowledgePath(index.legacy_support.questionStrategy)),
    readJson(resolveKnowledgePath(index.legacy_support.responseRules)),
  ]);

  const safetyLevels = riskDocument.risk_levels;
  const sources = sourceRegistry.sources;
  validateCollection('issueTypes', issueTypes, index.collections.issueTypes.expected_minimum);
  validateCollection('mechanisms', mechanisms, index.collections.mechanisms.expected_minimum);
  validateCollection('interventions', interventions, index.collections.interventions.expected_minimum);
  validateCollection('safetyLevels', safetyLevels, index.collections.safetyLevels.expected_minimum);
  validateCollection('sources', sources, index.collections.sourceRegistry.expected_minimum);
  validateSupportingDocuments({ questionStrategy, responseRules, crisisResponse, safetyLevels });
  validateReferences({ issueTypes, mechanisms, interventions });

  const highRiskKeywords = safetyLevels
    .filter((level) => level.id !== 'level_0')
    .flatMap((level) => Array.isArray(level.keywords) ? level.keywords : []);
  const stats = {
    issueTypes: issueTypes.length,
    mechanisms: mechanisms.length,
    interventions: interventions.length,
    safetyLevels: safetyLevels.length,
    sources: sources.length,
  };

  const knowledge = {
    version: 2,
    index,
    issueTypes: { version: 2, issue_types: issueTypes },
    mechanisms: { version: 2, mechanisms },
    interventions: { version: 2, interventions },
    safety: { version: 2, riskLevels: safetyLevels, crisisResponse },
    sourceRegistry,
    questionStrategy,
    responseRules,
    stats,
    // 兼容仍读取 v1 safetyRules 形状的调用方。
    safetyRules: {
      version: 2,
      high_risk_keywords: [...new Set(highRiskKeywords)],
      additional_risk_signals: safetyLevels.slice(1).flatMap((level) => level.signals),
      response_principles: safetyLevels.slice(1).flatMap((level) => level.must_include),
      response_template: crisisResponse.templates.level_2,
    },
  };

  cachedKnowledge = knowledge;
  cachedSignature = signature;
  console.info(`[knowledge] loaded v2: ${stats.issueTypes} issue types, ${stats.mechanisms} mechanisms, ${stats.interventions} interventions, ${stats.safetyLevels} safety levels, ${stats.sources} sources`);
  return knowledge;
}

export function clearKnowledgeCache() {
  cachedKnowledge = null;
  cachedSignature = '';
}

async function listJsonFiles(relativeDirectory) {
  const directory = resolveKnowledgePath(relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法读取知识库目录 ${relativePath(directory)}：${error.message}`);
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  if (files.length === 0) throw new Error(`知识库目录 ${relativePath(directory)} 中没有 JSON 文件。`);
  return files;
}

async function loadCollection(files, collectionName) {
  const documents = await Promise.all(files.map(readJson));
  return documents.flatMap((document, index) => {
    if (Array.isArray(document)) return document;
    if (document && typeof document === 'object' && typeof document.id === 'string') return [document];
    const knownArray = document?.[collectionName]
      || document?.issue_types
      || document?.mechanisms
      || document?.interventions;
    if (Array.isArray(knownArray)) return knownArray;
    throw new Error(`知识文件 ${relativePath(files[index])} 必须是单个条目或条目数组。`);
  });
}

async function readJson(filePath) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`无法读取知识文件 ${relativePath(filePath)}：${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`知识文件 ${relativePath(filePath)} 不是有效 JSON：${error.message}`);
  }
}

async function getSignature(files) {
  const stats = await Promise.all(files.map(async (filePath) => {
    try {
      const fileStat = await stat(filePath);
      return `${relativePath(filePath)}:${fileStat.mtimeMs}:${fileStat.size}`;
    } catch (error) {
      throw new Error(`无法检查知识文件 ${relativePath(filePath)}：${error.message}`);
    }
  }));
  return stats.join('|');
}

function validateIndex(index, filePath) {
  if (index?.version !== 2) throw new Error(`知识文件 ${relativePath(filePath)} 的 version 必须为 2。`);
  const collections = index.collections;
  const legacy = index.legacy_support;
  for (const key of ['issueTypes', 'mechanisms', 'interventions', 'safetyLevels', 'crisisResponse', 'sourceRegistry']) {
    if (!collections?.[key]) throw new Error(`知识文件 index.json 缺少 collections.${key}。`);
  }
  if (!legacy?.questionStrategy || !legacy?.responseRules) {
    throw new Error('知识文件 index.json 缺少 legacy_support.questionStrategy 或 responseRules。');
  }
}

function validateCollection(name, entries, expectedMinimum = 1) {
  if (!Array.isArray(entries) || entries.length < expectedMinimum) {
    throw new Error(`知识集合 ${name} 至少需要 ${expectedMinimum} 条，当前为 ${Array.isArray(entries) ? entries.length : 0} 条。`);
  }
  const seenIds = new Set();
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`知识集合 ${name} 的第 ${index + 1} 条必须是对象。`);
    }
    for (const field of REQUIRED_FIELDS[name]) validateRequiredField(name, entry, field);
    if (seenIds.has(entry.id)) throw new Error(`知识集合 ${name} 存在重复 id：${entry.id}。`);
    seenIds.add(entry.id);
  });
}

function validateRequiredField(collectionName, entry, field) {
  if (!(field in entry)) throw new Error(`知识条目 ${collectionName}/${entry.id || 'unknown'} 缺少必填字段 ${field}。`);
  if (ARRAY_FIELDS.has(field)) {
    if (!Array.isArray(entry[field]) || entry[field].length === 0 || entry[field].some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error(`知识条目 ${collectionName}/${entry.id || 'unknown'} 的 ${field} 必须是非空字符串数组。`);
    }
    return;
  }
  if (typeof entry[field] !== 'string' || (!entry[field].trim() && field !== 'url')) {
    throw new Error(`知识条目 ${collectionName}/${entry.id || 'unknown'} 的 ${field} 必须是${field === 'url' ? '' : '非空'}字符串。`);
  }
}

function validateSupportingDocuments({ questionStrategy, responseRules, crisisResponse, safetyLevels }) {
  if (!questionStrategy?.information_insufficient || !questionStrategy?.vague_detection) {
    throw new Error('知识文件 question_strategy.json 缺少 information_insufficient 或 vague_detection。');
  }
  if (!Array.isArray(responseRules?.boundaries) || !Array.isArray(responseRules?.prohibited)) {
    throw new Error('知识文件 response_rules.json 缺少 boundaries 或 prohibited。');
  }
  if (crisisResponse?.version !== 2 || !crisisResponse?.templates) {
    throw new Error('知识文件 safety/crisis_response.json 缺少 version=2 或 templates。');
  }
  for (const level of safetyLevels) {
    if (typeof crisisResponse.templates[level.id] !== 'string' || !crisisResponse.templates[level.id].trim()) {
      throw new Error(`知识文件 safety/crisis_response.json 缺少 ${level.id} 模板。`);
    }
  }
}

function validateReferences({ issueTypes, mechanisms, interventions }) {
  const issueIds = new Set(issueTypes.map((item) => item.id));
  const mechanismIds = new Set(mechanisms.map((item) => item.id));
  const interventionIds = new Set(interventions.map((item) => item.id));
  for (const issue of issueTypes) {
    validateIdReferences(`issueTypes/${issue.id}.common_mechanisms`, issue.common_mechanisms, mechanismIds);
    validateIdReferences(`issueTypes/${issue.id}.possible_interventions`, issue.possible_interventions, interventionIds);
  }
  for (const mechanism of mechanisms) {
    validateIdReferences(`mechanisms/${mechanism.id}.related_issue_types`, mechanism.related_issue_types, issueIds);
    validateIdReferences(`mechanisms/${mechanism.id}.related_interventions`, mechanism.related_interventions, interventionIds);
  }
}

function validateIdReferences(label, ids, knownIds) {
  const unknown = ids.filter((id) => !knownIds.has(id));
  if (unknown.length) throw new Error(`知识引用 ${label} 包含未知 id：${unknown.join(', ')}。`);
}

function resolveKnowledgePath(relativeFile) {
  const resolved = path.resolve(knowledgeDirectory, relativeFile);
  const relative = path.relative(knowledgeDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`知识库索引包含越界路径：${relativeFile}。`);
  }
  return resolved;
}

function relativePath(filePath) {
  return path.relative(knowledgeDirectory, filePath).replaceAll('\\', '/');
}
