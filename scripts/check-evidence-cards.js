import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const evidenceRoot = path.join(projectRoot, 'knowledge', 'evidence_cards');
const indexPath = path.join(evidenceRoot, 'index.json');
const sourceRegistryPath = path.join(
  projectRoot,
  'knowledge_sources',
  'registry',
  'source_registry.json',
);
const requiredCardFields = [
  'id',
  'title',
  'claim',
  'summary',
  'source_ids',
  'source_note_refs',
  'category',
  'applies_to',
  'not_applies_to',
  'allowed_claims',
  'forbidden_claims',
  'product_use',
  'evidence_level',
  'risk_level',
  'review_status',
  'review_notes',
];
const arrayFields = [
  'source_ids',
  'source_note_refs',
  'applies_to',
  'not_applies_to',
  'allowed_claims',
  'forbidden_claims',
  'product_use',
];
const categories = new Set([
  'safety',
  'self_help',
  'common_issues',
  'methods',
  'student_mental_health',
  'ai_ethics_privacy',
]);
const evidenceLevels = new Set([
  'official_guideline',
  'public_health_guidance',
  'clinical_guidance',
  'professional_framework',
  'product_ethics_guidance',
]);
const riskLevels = new Set(['low', 'medium', 'high', 'critical']);
const reviewStatuses = new Set(['machine_draft', 'needs_review', 'approved', 'deprecated']);
const sourceStatusRank = new Map([
  ['todo', 0],
  ['collected', 1],
  ['summarized', 2],
  ['needs_review', 3],
  ['approved', 4],
  ['deprecated', -1],
]);
const errors = [];

const sourceRegistry = readJson(sourceRegistryPath, 'source registry');
const sourcesById = new Map();
if (!Array.isArray(sourceRegistry)) {
  errors.push('[source registry] 顶层必须是数组');
} else {
  for (const source of sourceRegistry) {
    if (typeof source?.source_id === 'string' && source.source_id) {
      sourcesById.set(source.source_id, source);
    }
  }
}

const index = readJson(indexPath, 'index');
const indexEntries = Array.isArray(index?.cards) ? index.cards : [];
if (!index || typeof index !== 'object' || Array.isArray(index)) {
  errors.push('[index] 顶层必须是对象');
} else {
  if (!Array.isArray(index.cards)) errors.push('[index] cards 必须是数组');
  if (!reviewStatuses.has(index.review_status)) {
    errors.push(`[index] review_status 非法：${String(index.review_status)}`);
  }
  if (index.review_status === 'approved') {
    errors.push('[index] 当前阶段不允许 review_status=approved');
  }
}

const physicalPaths = new Set(
  existsSync(evidenceRoot)
    ? listJsonFiles(evidenceRoot)
      .filter((filePath) => path.resolve(filePath) !== path.resolve(indexPath))
      .map(toProjectPath)
    : [],
);
const physicalCards = new Map();
const cardIds = new Map();

for (const relativePath of [...physicalPaths].sort()) {
  const absolutePath = path.join(projectRoot, relativePath);
  const card = readJson(absolutePath, relativePath);
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

const indexedPaths = new Set();
const indexIds = new Set();
for (const [position, entry] of indexEntries.entries()) {
  const label = `index.cards[${position}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`[${label}] 必须是对象`);
    continue;
  }
  for (const field of ['id', 'path', 'category', 'source_ids', 'risk_level', 'review_status']) {
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
  const relativeToRoot = path.relative(evidenceRoot, resolvedPath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    errors.push(`[${label}] path 必须位于 knowledge/evidence_cards：${entry.path}`);
    continue;
  }
  if (indexedPaths.has(normalizedPath)) {
    errors.push(`[${label}] index 中 path 重复：${normalizedPath}`);
  }
  indexedPaths.add(normalizedPath);

  if (!existsSync(resolvedPath)) {
    errors.push(`[${label}] 文件不存在：${normalizedPath}`);
    continue;
  }
  const card = physicalCards.get(normalizedPath);
  if (!card) continue;
  if (card.id !== entry.id) {
    errors.push(`[${label}] card.id 与 index id 不一致：${card.id} !== ${entry.id}`);
  }
  if (card.category !== entry.category) {
    errors.push(`[${label}] card.category 与 index category 不一致`);
  }
  if (card.risk_level !== entry.risk_level) {
    errors.push(`[${label}] card.risk_level 与 index risk_level 不一致`);
  }
  if (card.review_status !== entry.review_status) {
    errors.push(`[${label}] card.review_status 与 index review_status 不一致`);
  }
  if (JSON.stringify(card.source_ids) !== JSON.stringify(entry.source_ids)) {
    errors.push(`[${label}] card.source_ids 与 index source_ids 不一致`);
  }
}

for (const physicalPath of physicalPaths) {
  if (!indexedPaths.has(physicalPath)) {
    errors.push(`[index] evidence card 文件未登记：${physicalPath}`);
  }
}
for (const indexedPath of indexedPaths) {
  if (!physicalPaths.has(indexedPath)) {
    errors.push(`[index] 登记路径不是 evidence card 文件：${indexedPath}`);
  }
}

printResult();

function validateCard(card, relativePath) {
  const label = typeof card?.id === 'string' && card.id ? card.id : relativePath;
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    errors.push(`[${label}] card 必须是对象`);
    return;
  }
  for (const field of requiredCardFields) {
    if (!Object.hasOwn(card, field)) errors.push(`[${label}] 缺少必填字段 ${field}`);
  }
  for (const field of ['id', 'title', 'claim', 'summary', 'category', 'evidence_level', 'risk_level', 'review_status', 'review_notes']) {
    if (typeof card[field] !== 'string' || !card[field].trim()) {
      errors.push(`[${label}] ${field} 必须是非空字符串`);
    }
  }
  for (const field of arrayFields) {
    if (!Array.isArray(card[field])) errors.push(`[${label}] ${field} 必须是数组`);
  }
  if (typeof card.summary === 'string' && card.summary.length > 150) {
    errors.push(`[${label}] summary 超过 150 字符：${card.summary.length}`);
  }
  if (!categories.has(card.category)) {
    errors.push(`[${label}] category 非法：${String(card.category)}`);
  }
  if (!evidenceLevels.has(card.evidence_level)) {
    errors.push(`[${label}] evidence_level 非法：${String(card.evidence_level)}`);
  }
  if (!riskLevels.has(card.risk_level)) {
    errors.push(`[${label}] risk_level 非法：${String(card.risk_level)}`);
  }
  if (!reviewStatuses.has(card.review_status)) {
    errors.push(`[${label}] review_status 非法：${String(card.review_status)}`);
  }
  if (card.review_status === 'approved') {
    errors.push(`[${label}] 当前阶段不允许 review_status=approved`);
  }
  if (!Array.isArray(card.allowed_claims) || card.allowed_claims.length === 0) {
    errors.push(`[${label}] allowed_claims 不能为空`);
  }
  if (!Array.isArray(card.forbidden_claims) || card.forbidden_claims.length === 0) {
    errors.push(`[${label}] forbidden_claims 不能为空`);
  }
  if (card.category === 'safety' && (!Array.isArray(card.forbidden_claims) || card.forbidden_claims.length === 0)) {
    errors.push(`[${label}] safety card 必须至少包含一个 forbidden_claim`);
  }
  if ((card.risk_level === 'high' || card.risk_level === 'critical')
      && (!Array.isArray(card.not_applies_to) || card.not_applies_to.length === 0)) {
    errors.push(`[${label}] high/critical card 必须包含 not_applies_to`);
  }

  if (Array.isArray(card.source_ids)) {
    if (card.source_ids.length === 0) errors.push(`[${label}] source_ids 不能为空`);
    for (const sourceId of card.source_ids) {
      const source = sourcesById.get(sourceId);
      if (!source) {
        errors.push(`[${label}] source_id 不存在：${String(sourceId)}`);
        continue;
      }
      const rank = sourceStatusRank.get(source.status);
      if (typeof rank !== 'number' || rank < sourceStatusRank.get('summarized')) {
        errors.push(`[${label}] source_id 尚未 summarized：${sourceId} (${String(source.status)})`);
      }
    }
  }

  const categoryFromPath = relativePath.split('/')[2];
  if (categories.has(categoryFromPath) && card.category !== categoryFromPath) {
    errors.push(`[${label}] category 与目录不一致：${card.category} !== ${categoryFromPath}`);
  }
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
  const counts = Object.fromEntries([...categories].map((category) => [category, 0]));
  for (const card of physicalCards.values()) {
    if (Object.hasOwn(counts, card.category)) counts[card.category] += 1;
  }
  console.log('Evidence cards summary:');
  console.log(`- total: ${physicalCards.size}`);
  for (const category of categories) console.log(`- ${category}: ${counts[category]}`);
  console.log(`- index_entries: ${indexEntries.length}`);

  if (errors.length > 0) {
    console.error('');
    console.error('Evidence cards check failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('Evidence cards check passed.');
}
