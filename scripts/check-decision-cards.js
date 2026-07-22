import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const decisionRoot = path.join(projectRoot, 'knowledge', 'decision_cards');
const indexPath = path.join(decisionRoot, 'index.json');
const evidenceIndexPath = path.join(projectRoot, 'knowledge', 'evidence_cards', 'index.json');
const requiredFields = [
  'id',
  'type',
  'name',
  'description',
  'match',
  'evidence_refs',
  'applies_to',
  'not_applies_to',
  'response_goals',
  'allowed_actions',
  'forbidden_actions',
  'priority',
  'risk_level',
  'review_status',
  'review_notes',
];
const arrayFields = [
  'evidence_refs',
  'applies_to',
  'not_applies_to',
  'response_goals',
  'allowed_actions',
  'forbidden_actions',
];
const types = new Set(['safety_rule', 'issue_type', 'mechanism', 'intervention', 'response_style']);
const priorities = new Set(['critical', 'high', 'medium', 'low']);
const riskLevels = new Set(['none', 'low', 'medium', 'high', 'critical']);
const reviewStatuses = new Set(['machine_draft', 'needs_review', 'approved', 'deprecated']);
const typeDirectories = new Map([
  ['safety_rule', 'safety_rules'],
  ['issue_type', 'issue_types'],
  ['mechanism', 'mechanisms'],
  ['intervention', 'interventions'],
  ['response_style', 'response_styles'],
]);
const highRiskForbidden = [
  '不进行普通心理分析',
  '不只给自助练习',
  '不承诺保密',
  '不淡化风险',
];
const criticalSafetyActions = [
  '建议立即联系当地紧急服务',
  '建议联系身边可信任的人',
  '建议远离危险物品或交由他人保管',
];
const issueForbidden = ['不做诊断', '不承诺疗效'];
const interventionForbidden = ['不用于高风险危机场景的唯一回应', '不承诺治疗效果'];
const requiredReviewNotes = '基于 machine_draft evidence_cards 生成，尚未经过专业人员复核。';
const errors = [];

const evidenceIndex = readJson(evidenceIndexPath, 'evidence index');
const evidenceById = new Map();
if (!Array.isArray(evidenceIndex?.cards)) {
  errors.push('[evidence index] cards 必须是数组');
} else {
  for (const evidence of evidenceIndex.cards) {
    if (typeof evidence?.id === 'string' && evidence.id) evidenceById.set(evidence.id, evidence);
  }
}

const index = readJson(indexPath, 'decision index');
const indexEntries = Array.isArray(index?.cards) ? index.cards : [];
if (!index || typeof index !== 'object' || Array.isArray(index)) {
  errors.push('[decision index] 顶层必须是对象');
} else {
  if (!Array.isArray(index.cards)) errors.push('[decision index] cards 必须是数组');
  if (!reviewStatuses.has(index.review_status)) {
    errors.push(`[decision index] review_status 非法：${String(index.review_status)}`);
  }
  if (index.review_status === 'approved') {
    errors.push('[decision index] 当前阶段不允许 review_status=approved');
  }
}

const physicalPaths = new Set(
  existsSync(decisionRoot)
    ? listJsonFiles(decisionRoot)
      .filter((filePath) => path.resolve(filePath) !== path.resolve(indexPath))
      .map(toProjectPath)
    : [],
);
const physicalCards = new Map();
const cardIds = new Map();

for (const relativePath of [...physicalPaths].sort()) {
  const card = readJson(path.join(projectRoot, relativePath), relativePath);
  if (!card) continue;
  physicalCards.set(relativePath, card);
  validateCard(card, relativePath);
  if (typeof card.id === 'string' && card.id) {
    if (cardIds.has(card.id)) {
      errors.push(`[${card.id}] id 重复：${cardIds.get(card.id)} 与 ${relativePath}`);
    } else {
      cardIds.set(card.id, relativePath);
    }
  }
}

validateDecisionLinks();

const indexedPaths = new Set();
const indexIds = new Set();
for (const [position, entry] of indexEntries.entries()) {
  const label = `decision index.cards[${position}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`[${label}] 必须是对象`);
    continue;
  }
  for (const field of ['id', 'path', 'type', 'evidence_refs', 'priority', 'risk_level', 'review_status']) {
    if (!Object.hasOwn(entry, field)) errors.push(`[${label}] 缺少字段 ${field}`);
  }
  if (typeof entry.id !== 'string' || !entry.id) {
    errors.push(`[${label}] id 必须是非空字符串`);
  } else if (indexIds.has(entry.id)) {
    errors.push(`[${label}] index 中 id 重复：${entry.id}`);
  } else {
    indexIds.add(entry.id);
  }
  if (typeof entry.path !== 'string' || !entry.path) {
    errors.push(`[${label}] path 必须是非空字符串`);
    continue;
  }

  const normalizedPath = entry.path.replaceAll('\\', '/');
  const resolvedPath = path.resolve(projectRoot, normalizedPath);
  const relativeToRoot = path.relative(decisionRoot, resolvedPath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    errors.push(`[${label}] path 必须位于 knowledge/decision_cards：${entry.path}`);
    continue;
  }
  if (indexedPaths.has(normalizedPath)) errors.push(`[${label}] index 中 path 重复：${normalizedPath}`);
  indexedPaths.add(normalizedPath);
  if (!existsSync(resolvedPath)) {
    errors.push(`[${label}] 文件不存在：${normalizedPath}`);
    continue;
  }

  const card = physicalCards.get(normalizedPath);
  if (!card) continue;
  compareIndexField(label, 'id', entry.id, card.id);
  compareIndexField(label, 'type', entry.type, card.type);
  compareIndexField(label, 'priority', entry.priority, card.priority);
  compareIndexField(label, 'risk_level', entry.risk_level, card.risk_level);
  compareIndexField(label, 'review_status', entry.review_status, card.review_status);
  if (JSON.stringify(entry.evidence_refs) !== JSON.stringify(card.evidence_refs)) {
    errors.push(`[${label}] evidence_refs 与 card 不一致`);
  }
}

for (const physicalPath of physicalPaths) {
  if (!indexedPaths.has(physicalPath)) errors.push(`[decision index] card 文件未登记：${physicalPath}`);
}
for (const indexedPath of indexedPaths) {
  if (!physicalPaths.has(indexedPath)) errors.push(`[decision index] 登记路径不是 card 文件：${indexedPath}`);
}

printResult();

function validateCard(card, relativePath) {
  const label = typeof card?.id === 'string' && card.id ? card.id : relativePath;
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    errors.push(`[${label}] card 必须是对象`);
    return;
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(card, field)) errors.push(`[${label}] 缺少通用必填字段 ${field}`);
  }
  for (const field of ['id', 'type', 'name', 'description', 'priority', 'risk_level', 'review_status', 'review_notes']) {
    if (typeof card[field] !== 'string' || !card[field].trim()) {
      errors.push(`[${label}] ${field} 必须是非空字符串`);
    }
  }
  for (const field of arrayFields) {
    if (!Array.isArray(card[field])) errors.push(`[${label}] ${field} 必须是数组`);
  }
  if (!card.match || typeof card.match !== 'object' || Array.isArray(card.match)) {
    errors.push(`[${label}] match 必须是对象`);
  } else {
    for (const field of ['keywords', 'signals', 'exclude']) {
      if (!Array.isArray(card.match[field])) errors.push(`[${label}] match.${field} 必须是数组`);
    }
  }
  if (!types.has(card.type)) errors.push(`[${label}] type 非法：${String(card.type)}`);
  if (!priorities.has(card.priority)) errors.push(`[${label}] priority 非法：${String(card.priority)}`);
  if (!riskLevels.has(card.risk_level)) errors.push(`[${label}] risk_level 非法：${String(card.risk_level)}`);
  if (!reviewStatuses.has(card.review_status)) {
    errors.push(`[${label}] review_status 非法：${String(card.review_status)}`);
  }
  if (card.review_status === 'approved') errors.push(`[${label}] 当前阶段不允许 review_status=approved`);
  if (card.review_notes !== requiredReviewNotes) errors.push(`[${label}] review_notes 不符合当前阶段统一文本`);
  if (!Array.isArray(card.evidence_refs) || card.evidence_refs.length === 0) {
    errors.push(`[${label}] evidence_refs 至少需要 1 个引用`);
  } else {
    for (const evidenceId of card.evidence_refs) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        errors.push(`[${label}] evidence_ref 不存在：${String(evidenceId)}`);
      } else if (evidence.review_status === 'deprecated') {
        errors.push(`[${label}] evidence_ref 已 deprecated：${evidenceId}`);
      }
    }
  }
  if (!Array.isArray(card.allowed_actions) || card.allowed_actions.length === 0) {
    errors.push(`[${label}] allowed_actions 不能为空`);
  }
  if (!Array.isArray(card.forbidden_actions) || card.forbidden_actions.length === 0) {
    errors.push(`[${label}] forbidden_actions 不能为空`);
  }
  if (card.type === 'safety_rule' && (!Array.isArray(card.response_goals) || card.response_goals.length === 0)) {
    errors.push(`[${label}] safety_rule 必须有 response_goals`);
  }
  if ((card.risk_level === 'high' || card.risk_level === 'critical')
      && (!Array.isArray(card.forbidden_actions) || card.forbidden_actions.length === 0)) {
    errors.push(`[${label}] high/critical card 必须有 forbidden_actions`);
  }
  if (card.type === 'safety_rule' && (card.risk_level === 'high' || card.risk_level === 'critical')) {
    requireArrayValues(label, card.forbidden_actions, highRiskForbidden, 'forbidden_actions');
  }
  if (card.type === 'safety_rule' && card.risk_level === 'critical') {
    requireArrayValues(label, card.allowed_actions, criticalSafetyActions, 'allowed_actions');
  }
  if (card.type === 'issue_type') {
    requireArrayField(card, label, 'possible_mechanisms');
    requireArrayField(card, label, 'recommended_interventions');
    requireArrayValues(label, card.forbidden_actions, issueForbidden, 'forbidden_actions');
  }
  if (card.type === 'mechanism') {
    if (typeof card.explain_to_user !== 'string' || !card.explain_to_user.trim()) {
      errors.push(`[${label}] mechanism 必须有 explain_to_user`);
    } else if (!/(可能|看起来像)/u.test(card.explain_to_user)) {
      errors.push(`[${label}] explain_to_user 必须使用“可能”或“看起来像”等非诊断表达`);
    }
    requireArrayField(card, label, 'linked_issue_types');
    requireArrayField(card, label, 'suitable_interventions');
  }
  if (card.type === 'intervention') {
    requireArrayField(card, label, 'steps');
    if (typeof card.max_duration_minutes !== 'number' || !Number.isFinite(card.max_duration_minutes)
        || card.max_duration_minutes <= 0) {
      errors.push(`[${label}] intervention.max_duration_minutes 必须是正数`);
    }
    requireArrayField(card, label, 'unsuitable_when');
    requireArrayValues(label, card.forbidden_actions, interventionForbidden, 'forbidden_actions');
  }
  if (card.type === 'response_style') {
    requireArrayField(card, label, 'tone_rules');
    requireArrayField(card, label, 'length_rules');
    requireArrayField(card, label, 'question_rules');
  }

  const directory = relativePath.split('/')[2];
  const expectedDirectory = typeDirectories.get(card.type);
  if (expectedDirectory && directory !== expectedDirectory) {
    errors.push(`[${label}] type 与目录不一致：${card.type} 应位于 ${expectedDirectory}`);
  }
}

function validateDecisionLinks() {
  const cardsById = new Map([...physicalCards.values()].map((card) => [card.id, card]));
  for (const card of physicalCards.values()) {
    if (card.type === 'issue_type') {
      validateLinks(card, 'possible_mechanisms', 'mechanism', cardsById);
      validateLinks(card, 'recommended_interventions', 'intervention', cardsById);
    }
    if (card.type === 'mechanism') {
      validateLinks(card, 'linked_issue_types', 'issue_type', cardsById);
      validateLinks(card, 'suitable_interventions', 'intervention', cardsById);
    }
  }
}

function validateLinks(card, field, expectedType, cardsById) {
  if (!Array.isArray(card[field])) return;
  for (const linkedId of card[field]) {
    const linkedCard = cardsById.get(linkedId);
    if (!linkedCard) {
      errors.push(`[${card.id}] ${field} 引用不存在：${String(linkedId)}`);
    } else if (linkedCard.type !== expectedType) {
      errors.push(`[${card.id}] ${field} 引用类型错误：${linkedId} 不是 ${expectedType}`);
    }
  }
}

function requireArrayField(card, label, field) {
  if (!Array.isArray(card[field]) || card[field].length === 0) {
    errors.push(`[${label}] ${field} 必须是非空数组`);
  }
}

function requireArrayValues(label, actual, required, field) {
  if (!Array.isArray(actual)) return;
  for (const value of required) {
    if (!actual.includes(value)) errors.push(`[${label}] ${field} 缺少：${value}`);
  }
}

function compareIndexField(label, field, indexedValue, cardValue) {
  if (indexedValue !== cardValue) errors.push(`[${label}] ${field} 与 card 不一致`);
}

function listJsonFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFiles(entryPath));
    if (entry.isFile() && entry.name.endsWith('.json')) files.push(entryPath);
  }
  return files;
}

function readJson(filePath, label) {
  if (!existsSync(filePath)) {
    errors.push(`[${label}] 文件不存在：${toProjectPath(filePath)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`[${label}] JSON 格式错误：${error.message}`);
    return null;
  }
}

function toProjectPath(filePath) {
  return path.relative(projectRoot, filePath).replaceAll('\\', '/');
}

function printResult() {
  const counts = Object.fromEntries([...types].map((type) => [type, 0]));
  for (const card of physicalCards.values()) {
    if (Object.hasOwn(counts, card.type)) counts[card.type] += 1;
  }
  console.log('Decision cards summary:');
  console.log(`- total: ${physicalCards.size}`);
  for (const type of types) console.log(`- ${type}: ${counts[type]}`);
  console.log(`- index_entries: ${indexEntries.length}`);

  if (errors.length > 0) {
    console.error('');
    console.error('Decision cards check failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('Decision cards check passed.');
}
