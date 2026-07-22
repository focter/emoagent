import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const knowledgeRoot = path.join(projectRoot, 'server', 'knowledge');
const outputDirectory = path.join(projectRoot, 'docs', 'review');
const outputJson = path.join(outputDirectory, 'knowledge-review.json');
const outputCsv = path.join(outputDirectory, 'knowledge-review.csv');
const outputSummary = path.join(outputDirectory, 'knowledge-review-summary.md');
const args = new Set(process.argv.slice(2));
const overwrite = args.has('--overwrite');

const standardReviewStatuses = new Set([
  'unreviewed',
  'reviewed_by_self',
  'reviewed_by_psychology_student',
  'reviewed_by_professional',
]);

const collectionSpecs = [
  { type: 'issue_type', directory: 'issue_types' },
  { type: 'mechanism', directory: 'mechanisms' },
  { type: 'intervention', directory: 'interventions' },
];

await main();

async function main() {
  const sources = await loadSourceRegistry();
  const entries = [
    ...(await loadEntityCollection(collectionSpecs[0])),
    ...(await loadEntityCollection(collectionSpecs[1])),
    ...(await loadEntityCollection(collectionSpecs[2])),
    ...(await loadSafetyEntries()),
  ].map((entry) => createReviewEntry(entry, sources));

  const document = {
    export_version: 1,
    generated_at: new Date().toISOString(),
    scope: 'server/knowledge runtime knowledge base',
    warning:
      'This file is a review worksheet. Automated checks do not prove clinical, legal, or product safety readiness.',
    counts: countBy(entries, (entry) => entry.type),
    review_status_summary: countBy(entries, (entry) => entry.normalized_review_status),
    source_level_summary: countBy(entries, (entry) => entry.source_level || 'missing'),
    source_registry: [...sources.values()],
    reviewer_workflow: {
      allowed_decisions: ['approve', 'approve_with_minor_changes', 'needs_revision', 'reject'],
      recommended_review_order: [
        'safety_level',
        'safety_response_templates',
        'issue_type',
        'mechanism',
        'intervention',
      ],
      reviewer_fields:
        'Fill review_decision, reviewer, reviewed_at, reviewer_notes, required_changes, and checklist fields.',
    },
    entries,
  };

  await mkdir(outputDirectory, { recursive: true });
  await writeOutput(outputJson, `${JSON.stringify(document, null, 2)}\n`);
  await writeOutput(outputCsv, `\uFEFF${toCsv(entries)}`);
  await writeOutput(outputSummary, createSummaryMarkdown(document));

  console.log('Knowledge review export written:');
  console.log(`- ${relativePath(outputJson)}`);
  console.log(`- ${relativePath(outputCsv)}`);
  console.log(`- ${relativePath(outputSummary)}`);
  console.log(`Entries: ${entries.length}`);
}

async function loadEntityCollection(spec) {
  const directory = path.join(knowledgeRoot, spec.directory);
  const fileNames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  const entries = [];
  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    const document = await readJson(filePath);
    const values = Array.isArray(document) ? document : [document];
    for (const value of values) {
      entries.push({
        type: spec.type,
        value,
        sourcePath: relativePath(filePath),
      });
    }
  }
  return entries;
}

async function loadSafetyEntries() {
  const riskPath = path.join(knowledgeRoot, 'safety', 'risk_levels.json');
  const crisisPath = path.join(knowledgeRoot, 'safety', 'crisis_response.json');
  const riskDocument = await readJson(riskPath);
  const crisisResponse = await readJson(crisisPath);
  const riskLevels = Array.isArray(riskDocument.risk_levels) ? riskDocument.risk_levels : [];

  return [
    ...riskLevels.map((level) => ({
      type: 'safety_level',
      value: {
        ...level,
        source_level: level.source_level || riskDocument.source_level,
        review_status: level.review_status || riskDocument.review_status,
      },
      sourcePath: `${relativePath(riskPath)}#${level.id}`,
    })),
    {
      type: 'safety_response_templates',
      value: {
        id: 'crisis_response',
        name: 'Crisis response templates',
        ...crisisResponse,
      },
      sourcePath: `${relativePath(crisisPath)}#crisis_response`,
    },
  ];
}

async function loadSourceRegistry() {
  const registryPath = path.join(knowledgeRoot, 'source_registry.json');
  const registry = await readJson(registryPath);
  const sources = new Map();
  for (const source of registry.sources || []) {
    if (typeof source?.id === 'string') sources.set(source.id, source);
  }
  return sources;
}

function createReviewEntry({ type, value, sourcePath }, sources) {
  const sourceIds = extractSourceReferences(value);
  const normalizedReviewStatus = standardReviewStatuses.has(value.review_status)
    ? value.review_status
    : 'unreviewed';

  return {
    entry_key: `${type}:${value.id}`,
    type,
    id: value.id,
    name: value.name || value.title || value.id,
    source_path: sourcePath,
    review_status: value.review_status || '',
    normalized_review_status: normalizedReviewStatus,
    source_level: value.source_level || '',
    source_ids: sourceIds,
    sources: sourceIds.map((id) => sources.get(id) || { id, missing: true }),
    risk_class: classifyRisk(type, value),
    summary: summarizeEntry(type, value),
    user_facing_text: collectUserFacingText(type, value),
    linked_ids: collectLinkedIds(type, value),
    checklist: {
      clinical_or_psychological_accuracy: null,
      safety_boundary_ok: null,
      non_diagnostic_wording_ok: null,
      no_treatment_or_effect_promise: null,
      escalation_or_help_seeking_ok: null,
      privacy_or_sensitive_data_ok: null,
      localization_needed: null,
    },
    review_decision: '',
    reviewer: '',
    reviewed_at: '',
    reviewer_notes: '',
    required_changes: [],
    raw: value,
  };
}

function classifyRisk(type, value) {
  if (type === 'safety_response_templates') return 'safety_critical_review';
  if (type === 'safety_level') {
    if (['level_3', 'level_4'].includes(value.id)) return 'high_or_imminent_risk';
    if (['level_1', 'level_2'].includes(value.id)) return 'self_harm_risk';
    return 'routine_safety_boundary';
  }
  if (value.source_level === 'L1_product_safety_rule') return 'product_safety_rule';
  if (value.source_level === 'L2_safety_informed') return 'safety_informed';
  return 'ordinary_psychoeducation';
}

function summarizeEntry(type, value) {
  if (type === 'issue_type') {
    return joinSentences([
      value.description,
      value.key_dimensions?.length ? `Key dimensions: ${value.key_dimensions.join('; ')}` : '',
      value.escalation_signals?.length ? `Escalation signals: ${value.escalation_signals.join('; ')}` : '',
    ]);
  }
  if (type === 'mechanism') {
    return joinSentences([
      value.plain_explanation,
      value.use_when?.length ? `Use when: ${value.use_when.join('; ')}` : '',
      value.do_not_use_when?.length ? `Do not use when: ${value.do_not_use_when.join('; ')}` : '',
    ]);
  }
  if (type === 'intervention') {
    return joinSentences([
      value.natural_prompt,
      value.suitable_for?.length ? `Suitable for: ${value.suitable_for.join('; ')}` : '',
      value.not_suitable_for?.length ? `Not suitable for: ${value.not_suitable_for.join('; ')}` : '',
    ]);
  }
  if (type === 'safety_level') {
    return joinSentences([
      value.response_goal,
      value.signals?.length ? `Signals: ${value.signals.join('; ')}` : '',
      value.escalation_action ? `Escalation: ${value.escalation_action}` : '',
    ]);
  }
  return joinSentences([
    value.usage_note,
    value.templates ? `Template levels: ${Object.keys(value.templates).join(', ')}` : '',
  ]);
}

function collectUserFacingText(type, value) {
  if (type === 'issue_type') {
    return {
      user_expressions: value.user_expressions || [],
      first_followups: value.first_followups || [],
      do_not_say: value.do_not_say || [],
    };
  }
  if (type === 'mechanism') {
    return {
      plain_explanation: value.plain_explanation || '',
      natural_response_examples: value.natural_response_examples || [],
      safe_small_actions: value.safe_small_actions || [],
      avoid: value.avoid || [],
    };
  }
  if (type === 'intervention') {
    return {
      instruction: value.instruction || [],
      natural_prompt: value.natural_prompt || '',
      example: value.example || '',
      safety_notes: value.safety_notes || [],
      avoid: value.avoid || [],
    };
  }
  if (type === 'safety_level') {
    return {
      must_include: value.must_include || [],
      must_not_include: value.must_not_include || [],
      allowed_followups: value.allowed_followups || [],
      escalation_action: value.escalation_action || '',
    };
  }
  return {
    templates: value.templates || {},
    usage_note: value.usage_note || '',
  };
}

function collectLinkedIds(type, value) {
  if (type === 'issue_type') {
    return {
      common_mechanisms: value.common_mechanisms || [],
      possible_interventions: value.possible_interventions || [],
    };
  }
  if (type === 'mechanism') {
    return {
      related_issue_types: value.related_issue_types || [],
      related_interventions: value.related_interventions || [],
    };
  }
  return {};
}

function extractSourceReferences(value) {
  const references = [];
  for (const key of ['source_id', 'source_ids', 'source_refs']) {
    const raw = value?.[key];
    if (typeof raw === 'string') references.push(raw);
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'string') references.push(item);
        else if (typeof item?.id === 'string') references.push(item.id);
      }
    }
  }
  return [...new Set(references)];
}

function toCsv(entries) {
  const columns = [
    'entry_key',
    'type',
    'id',
    'name',
    'source_path',
    'review_status',
    'normalized_review_status',
    'source_level',
    'risk_class',
    'summary',
    'checklist.clinical_or_psychological_accuracy',
    'checklist.safety_boundary_ok',
    'checklist.non_diagnostic_wording_ok',
    'checklist.no_treatment_or_effect_promise',
    'checklist.escalation_or_help_seeking_ok',
    'checklist.privacy_or_sensitive_data_ok',
    'checklist.localization_needed',
    'review_decision',
    'reviewer',
    'reviewed_at',
    'reviewer_notes',
    'required_changes',
  ];
  return [
    columns.join(','),
    ...entries.map((entry) => columns.map((column) => csvCell(csvValue(entry, column))).join(',')),
  ].join('\n') + '\n';
}

function csvValue(entry, column) {
  if (column.startsWith('checklist.')) {
    const checklistKey = column.slice('checklist.'.length);
    return entry.checklist?.[checklistKey] ?? '';
  }
  const value = entry[column];
  if (Array.isArray(value)) return value.join('; ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value ?? '';
}

function csvCell(value) {
  const text = String(value).replace(/\r?\n/g, ' ');
  const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function createSummaryMarkdown(document) {
  const lines = [
    '# Knowledge Review Export',
    '',
    `Generated at: ${document.generated_at}`,
    '',
    '## Counts',
    '',
    ...Object.entries(document.counts).map(([type, count]) => `- ${type}: ${count}`),
    '',
    '## Review Status Summary',
    '',
    ...Object.entries(document.review_status_summary).map(([status, count]) => `- ${status}: ${count}`),
    '',
    '## Source Level Summary',
    '',
    ...Object.entries(document.source_level_summary).map(([level, count]) => `- ${level}: ${count}`),
    '',
    '## How To Use',
    '',
    '1. Review safety levels and crisis response templates first.',
    '2. Fill reviewer fields and checklist values in `knowledge-review.json`; use `knowledge-review.csv` as a spreadsheet-friendly companion.',
    '3. Run `npm run review:knowledge:validate` while review is in progress.',
    '4. Run `npm run review:knowledge:validate:strict` before treating the worksheet as complete.',
    '5. Do not treat automated PASS results as clinical or legal approval.',
    '6. Keep any real user examples de-identified before adding them to review notes.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeOutput(filePath, content) {
  if (!overwrite && await exists(filePath)) {
    throw new Error(`${relativePath(filePath)} already exists. Re-run with --overwrite to replace it.`);
  }
  await writeFile(filePath, content, 'utf8');
}

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function joinSentences(parts) {
  return parts.filter(Boolean).join(' ');
}

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).replaceAll('\\', '/');
}
