import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultReviewFile = path.join(projectRoot, 'docs', 'review', 'knowledge-review.json');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const fileArg = args.find((arg) => arg.startsWith('--file='));
const reviewFile = fileArg ? path.resolve(projectRoot, fileArg.slice('--file='.length)) : defaultReviewFile;

const allowedDecisions = new Set([
  'approve',
  'approve_with_minor_changes',
  'needs_revision',
  'reject',
]);
const checklistKeys = [
  'clinical_or_psychological_accuracy',
  'safety_boundary_ok',
  'non_diagnostic_wording_ok',
  'no_treatment_or_effect_promise',
  'escalation_or_help_seeking_ok',
  'privacy_or_sensitive_data_ok',
  'localization_needed',
];
const approvalRequiredChecklistKeys = checklistKeys.filter((key) => key !== 'localization_needed');

try {
  const review = await readJson(reviewFile);
  const report = validateReviewDocument(review);
  printReport(report);
  if (report.errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`Knowledge review validation failed: ${error.message}`);
  process.exitCode = 1;
}

function validateReviewDocument(review) {
  const errors = [];
  const warnings = [];
  const entries = Array.isArray(review.entries) ? review.entries : [];
  const decisions = new Map();

  if (!entries.length) {
    errors.push('Review file must contain a non-empty entries array.');
  }

  for (const entry of entries) {
    const key = entry.entry_key || `${entry.type || 'entry'}:${entry.id || 'unknown'}`;
    const decision = normalizeString(entry.review_decision);
    decisions.set(decision || 'unfilled', (decisions.get(decision || 'unfilled') || 0) + 1);

    if (!decision) {
      const message = `${key}: review_decision is empty.`;
      if (strict) errors.push(message);
      continue;
    }

    if (!allowedDecisions.has(decision)) {
      errors.push(`${key}: review_decision must be one of ${[...allowedDecisions].join(', ')}.`);
      continue;
    }

    if (!normalizeString(entry.reviewer)) {
      errors.push(`${key}: reviewer is required when review_decision is set.`);
    }

    const reviewedAt = normalizeString(entry.reviewed_at);
    if (!reviewedAt) {
      errors.push(`${key}: reviewed_at is required when review_decision is set.`);
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)) {
      errors.push(`${key}: reviewed_at must use YYYY-MM-DD.`);
    }

    validateChecklist(entry, key, decision, errors, warnings);
    validateRequiredChanges(entry, key, decision, errors);

    if ((decision === 'needs_revision' || decision === 'reject') && !normalizeString(entry.reviewer_notes)) {
      errors.push(`${key}: reviewer_notes is required for ${decision}.`);
    }
  }

  if (!strict && decisions.get('unfilled')) {
    warnings.push(
      `${decisions.get('unfilled')} entries are still unreviewed. Use --strict before treating the review as complete.`,
    );
  }

  return {
    file: relativePath(reviewFile),
    strict,
    total: entries.length,
    decisions: Object.fromEntries([...decisions.entries()].sort()),
    errors,
    warnings,
  };
}

function validateChecklist(entry, key, decision, errors, warnings) {
  const checklist = entry.checklist;
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist)) {
    errors.push(`${key}: checklist object is required when review_decision is set.`);
    return;
  }

  for (const checklistKey of checklistKeys) {
    if (typeof checklist[checklistKey] !== 'boolean') {
      errors.push(`${key}: checklist.${checklistKey} must be true or false.`);
    }
  }

  if (decision === 'approve' || decision === 'approve_with_minor_changes') {
    for (const checklistKey of approvalRequiredChecklistKeys) {
      if (checklist[checklistKey] !== true) {
        errors.push(`${key}: checklist.${checklistKey} must be true for ${decision}.`);
      }
    }
  }

  if (decision === 'approve' && checklist.localization_needed === true) {
    warnings.push(`${key}: localization_needed is true on an approved entry; confirm this is intentional.`);
  }
}

function validateRequiredChanges(entry, key, decision, errors) {
  const changes = Array.isArray(entry.required_changes)
    ? entry.required_changes.filter((item) => normalizeString(item))
    : [];

  if (!Array.isArray(entry.required_changes)) {
    errors.push(`${key}: required_changes must be an array.`);
    return;
  }

  if ((decision === 'approve_with_minor_changes' || decision === 'needs_revision') && changes.length === 0) {
    errors.push(`${key}: required_changes must describe the requested changes for ${decision}.`);
  }
}

function printReport(report) {
  console.log('Knowledge review validation');
  console.log(`- file: ${report.file}`);
  console.log(`- strict: ${report.strict ? 'yes' : 'no'}`);
  console.log(`- entries: ${report.total}`);
  console.log('- decisions:');
  for (const [decision, count] of Object.entries(report.decisions)) {
    console.log(`  - ${decision}: ${count}`);
  }

  if (report.warnings.length) {
    console.log('\nWarnings:');
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }

  if (report.errors.length) {
    console.log('\nErrors:');
    for (const error of report.errors) console.log(`- ${error}`);
    console.log(`\nResult: FAIL (${report.errors.length} errors, ${report.warnings.length} warnings)`);
    return;
  }

  const result = report.warnings.length ? 'PASS WITH WARNINGS' : 'PASS';
  console.log(`\nResult: ${result} (0 errors, ${report.warnings.length} warnings)`);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}
