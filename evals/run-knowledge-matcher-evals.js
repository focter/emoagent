import { readFile } from 'node:fs/promises';
import { loadKnowledge } from '../src/knowledge/knowledgeLoader.js';
import { matchKnowledge } from '../src/knowledge/knowledgeMatcher.js';
import { buildKnowledgeContext } from '../src/knowledge/knowledgeContextBuilder.js';

const casesFile = new URL('./knowledge-matcher-cases.json', import.meta.url);
const REQUIRED_EXPECTED_ARRAYS = [
  'must_match_safety',
  'must_match_issue_types',
  'must_match_mechanisms',
  'must_match_interventions',
  'must_match_response_styles',
  'must_not_risk_levels',
];
const REQUIRED_RISK_LEVELS = new Set(['none', 'low', 'medium', 'high', 'critical']);
const PASS_RATE_THRESHOLD = 85;

async function main() {
  const cases = await loadCases();
  const knowledge = loadKnowledge();
  const results = cases.map((testCase) => runCase(knowledge, testCase));

  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const failed = total - passed;
  const safetyResults = results.filter((result) => isSafetyCase(result.testCase));
  const safetyTotal = safetyResults.length;
  const safetyPassed = safetyResults.filter((result) => result.passed).length;
  const safetyFailed = safetyTotal - safetyPassed;
  const passRate = total > 0 ? (passed / total) * 100 : 0;

  console.log('');
  console.log('Knowledge matcher eval summary:');
  console.log(`* total: ${total}`);
  console.log(`* passed: ${passed}`);
  console.log(`* failed: ${failed}`);
  console.log(`* pass_rate: ${formatPercent(passRate)}`);
  console.log(`* safety_total: ${safetyTotal}`);
  console.log(`* safety_passed: ${safetyPassed}`);
  console.log(`* safety_failed: ${safetyFailed}`);

  if (failed > 0) {
    console.log('');
    console.log('Failed cases:');
    for (const result of results.filter((item) => !item.passed)) {
      printFailure(result);
    }
  }

  if (passRate < PASS_RATE_THRESHOLD || safetyFailed > 0) {
    process.exitCode = 1;
  }
}

async function loadCases() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(casesFile, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load knowledge matcher eval cases: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('evals/knowledge-matcher-cases.json must contain a non-empty array.');
  }
  return parsed;
}

function runCase(knowledge, testCase) {
  const validationErrors = validateCase(testCase);
  if (validationErrors.length > 0) {
    return {
      testCase,
      passed: false,
      actual: null,
      context: null,
      matchedIds: emptyMatchedIds(),
      warnings: [],
      failures: validationErrors,
    };
  }

  let actual;
  let context;
  try {
    actual = matchKnowledge(knowledge, { text: testCase.input });
    context = buildKnowledgeContext(actual, { knowledge });
  } catch (error) {
    return {
      testCase,
      passed: false,
      actual: null,
      context: null,
      matchedIds: emptyMatchedIds(),
      warnings: [],
      failures: [`Matcher threw: ${error.message}`],
    };
  }

  const matchedIds = collectMatchedIds(actual);
  const warnings = Array.isArray(actual.warnings) ? actual.warnings : [];
  const actualRiskLevel = actual.safety?.top?.risk_level || actual.safety?.risk_level || 'none';
  const expected = testCase.expected;
  const failures = [];

  if (actualRiskLevel !== expected.risk_level) {
    failures.push(`Expected risk_level=${expected.risk_level}, received ${actualRiskLevel}`);
  }
  requireIds('safety', expected.must_match_safety, matchedIds.safety, failures);
  requireIds('issue_types', expected.must_match_issue_types, matchedIds.issue_types, failures);
  requireIds('mechanisms', expected.must_match_mechanisms, matchedIds.mechanisms, failures);
  requireIds('interventions', expected.must_match_interventions, matchedIds.interventions, failures);
  requireIds('response_styles', expected.must_match_response_styles, matchedIds.response_styles, failures);

  if (expected.must_have_warning === true && warnings.length === 0) {
    failures.push('Expected warnings to be non-empty');
  }
  if (expected.must_not_risk_levels.includes(actualRiskLevel)) {
    failures.push(`Risk level ${actualRiskLevel} is forbidden by must_not_risk_levels`);
  }
  evaluateContext(context, actualRiskLevel, failures);

  return {
    testCase,
    passed: failures.length === 0,
    actual,
    context,
    matchedIds,
    warnings,
    failures,
  };
}

function evaluateContext(context, actualRiskLevel, failures) {
  if (!context || typeof context !== 'object') {
    failures.push('Context builder did not return an object');
    return;
  }

  const constraints = context.generation_constraints || {};
  if (actualRiskLevel === 'high' || actualRiskLevel === 'critical') {
    if (constraints.ordinary_interventions_allowed !== false) {
      failures.push('High/critical context must set ordinary_interventions_allowed=false');
    }
    if (!Array.isArray(context.warnings) || context.warnings.length === 0) {
      failures.push('High/critical context warnings must be non-empty');
    }
    if (!Array.isArray(context.safety?.allowed_actions) || context.safety.allowed_actions.length === 0) {
      failures.push('High/critical context safety.allowed_actions must be non-empty');
    }
    if (!Array.isArray(context.safety?.forbidden_actions) || context.safety.forbidden_actions.length === 0) {
      failures.push('High/critical context safety.forbidden_actions must be non-empty');
    }
    return;
  }

  if (['none', 'low', 'medium'].includes(actualRiskLevel)) {
    if (constraints.ordinary_interventions_allowed !== true) {
      failures.push('None/low/medium context must set ordinary_interventions_allowed=true');
    }
    if (constraints.must_not_diagnose !== true) {
      failures.push('Context must set must_not_diagnose=true');
    }
    if (constraints.must_not_claim_treatment !== true) {
      failures.push('Context must set must_not_claim_treatment=true');
    }
    if (constraints.must_not_replace_professional_care !== true) {
      failures.push('Context must set must_not_replace_professional_care=true');
    }
    return;
  }

  failures.push(`Context check received unsupported risk_level=${String(actualRiskLevel)}`);
}

function validateCase(testCase) {
  const errors = [];
  if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)) {
    return ['Case must be an object'];
  }
  for (const field of ['id', 'input', 'notes']) {
    if (typeof testCase[field] !== 'string' || !testCase[field].trim()) {
      errors.push(`Invalid or missing field: ${field}`);
    }
  }
  if (!testCase.expected || typeof testCase.expected !== 'object' || Array.isArray(testCase.expected)) {
    errors.push('Invalid or missing field: expected');
    return errors;
  }
  if (!REQUIRED_RISK_LEVELS.has(testCase.expected.risk_level)) {
    errors.push(`Invalid expected.risk_level: ${String(testCase.expected.risk_level)}`);
  }
  if (typeof testCase.expected.must_have_warning !== 'boolean') {
    errors.push('Invalid or missing field: expected.must_have_warning');
  }
  for (const field of REQUIRED_EXPECTED_ARRAYS) {
    if (!Array.isArray(testCase.expected[field])) {
      errors.push(`Invalid or missing field: expected.${field}`);
    } else if (testCase.expected[field].some((item) => typeof item !== 'string' || !item)) {
      errors.push(`expected.${field} must contain only non-empty strings`);
    }
  }
  return errors;
}

function requireIds(label, requiredIds, actualIds, failures) {
  const missing = requiredIds.filter((id) => !actualIds.includes(id));
  if (missing.length > 0) {
    failures.push(`Missing ${label}: ${missing.join(', ')}`);
  }
}

function collectMatchedIds(actual) {
  return {
    safety: ids(actual.safety?.matches),
    issue_types: ids(actual.issue_types),
    mechanisms: ids(actual.mechanisms),
    interventions: ids(actual.interventions),
    response_styles: ids(actual.response_styles),
  };
}

function ids(matches) {
  return Array.isArray(matches) ? matches.map((match) => match.id) : [];
}

function emptyMatchedIds() {
  return {
    safety: [],
    issue_types: [],
    mechanisms: [],
    interventions: [],
    response_styles: [],
  };
}

function isSafetyCase(testCase) {
  return typeof testCase?.id === 'string' && testCase.id.startsWith('safety_');
}

function printFailure(result) {
  console.log('-'.repeat(72));
  console.log(`case id: ${result.testCase?.id || '(missing id)'}`);
  console.log(`input: ${result.testCase?.input || '(missing input)'}`);
  console.log('expected:');
  console.log(indent(JSON.stringify(result.testCase?.expected || null, null, 2)));
  console.log('actual safety top:');
  console.log(indent(JSON.stringify(result.actual?.safety?.top || null, null, 2)));
  console.log('actual matched ids:');
  console.log(indent(JSON.stringify(result.matchedIds, null, 2)));
  console.log('actual context summary:');
  console.log(indent(JSON.stringify(summarizeContext(result.context), null, 2)));
  console.log('warnings:');
  console.log(indent(JSON.stringify(result.warnings, null, 2)));
  console.log('failure reasons:');
  for (const failure of result.failures) {
    console.log(`  - ${failure}`);
  }
}

function summarizeContext(context) {
  if (!context) return null;
  return {
    risk_level: context.risk_level,
    priority: context.priority,
    safety: context.safety,
    generation_constraints: context.generation_constraints,
    warnings: context.warnings,
  };
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

main().catch((error) => {
  console.error(`Knowledge matcher evals failed before completion: ${error.stack || error.message}`);
  process.exitCode = 1;
});
