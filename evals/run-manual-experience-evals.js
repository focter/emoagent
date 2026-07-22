import { readFile } from 'node:fs/promises';
import { loadKnowledge } from '../src/knowledge/knowledgeLoader.js';
import { matchKnowledge } from '../src/knowledge/knowledgeMatcher.js';
import { buildKnowledgeContext } from '../src/knowledge/knowledgeContextBuilder.js';
import { RISK_WEIGHTS } from '../src/knowledge/knowledgeTypes.js';

const casesFile = new URL('./manual-experience-cases.json', import.meta.url);
const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const failuresOnly = args.has('--failures-only');
const HIGH_RISK_LEVELS = new Set(['high', 'critical']);

async function main() {
  const cases = await loadCases();
  const knowledge = loadKnowledge();
  const results = cases.map((testCase) => evaluateCase(knowledge, testCase));
  const summary = summarize(results);

  if (jsonMode) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    printHumanReadable(results, summary);
  }

  if (summary.failed > 0) process.exitCode = 1;
}

async function loadCases() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(casesFile, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load manual experience cases: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('evals/manual-experience-cases.json must contain a non-empty array.');
  }
  return parsed;
}

function evaluateCase(knowledge, testCase) {
  const validationFailures = validateCase(testCase);
  if (validationFailures.length > 0) {
    return buildResult(testCase, null, [], validationFailures, [], 'fail');
  }

  let matcherResult;
  let context;
  try {
    matcherResult = matchKnowledge(knowledge, { text: testCase.input });
    context = buildKnowledgeContext(matcherResult, { knowledge });
  } catch (error) {
    return buildResult(
      testCase,
      null,
      [],
      [`Matcher/context builder threw: ${error.message}`],
      [],
      'fail',
    );
  }

  const actual = collectActual(context);
  const failures = [];
  const notes = [];
  let status = 'pass';

  const riskStatus = evaluateRisk(testCase.expected_risk_level, actual.actual_risk_level);
  if (riskStatus === 'fail') {
    failures.push(`Expected risk_level=${testCase.expected_risk_level}, received ${actual.actual_risk_level}`);
  } else if (riskStatus === 'conservative_pass') {
    status = 'conservative_pass';
    notes.push(`Risk level is more conservative than expected: expected ${testCase.expected_risk_level}, received ${actual.actual_risk_level}`);
  }

  requireAny('issue_types', testCase.expected_issue_types, actual.actual_issue_types, failures);
  requireAny('mechanisms', testCase.expected_mechanisms, actual.actual_mechanisms, failures);
  requireAny('interventions', testCase.expected_interventions, actual.actual_interventions, failures);
  requireAny('response_styles', testCase.expected_response_styles, actual.actual_response_styles, failures);

  if (actual.ordinary_interventions_allowed !== testCase.expect_ordinary_interventions_allowed) {
    failures.push(`Expected ordinary_interventions_allowed=${testCase.expect_ordinary_interventions_allowed}, received ${actual.ordinary_interventions_allowed}`);
  }

  if (actual.prompt_injected_when_prompt_enabled !== testCase.expect_prompt_injected_when_prompt_enabled) {
    failures.push(`Expected prompt_injected_when_prompt_enabled=${testCase.expect_prompt_injected_when_prompt_enabled}, received ${actual.prompt_injected_when_prompt_enabled}`);
  }

  if (HIGH_RISK_LEVELS.has(testCase.expected_risk_level)) {
    if (actual.ordinary_interventions_allowed !== false) {
      failures.push('High/critical cases must set ordinary_interventions_allowed=false');
    }
    if (actual.disabled_by_safety_interventions.length !== actual.actual_interventions.length) {
      failures.push('High/critical cases must mark all retained ordinary interventions disabled_by_safety=true');
    }
    if (actual.prompt_injected_when_prompt_enabled !== false) {
      failures.push('High/critical cases must not inject prompt context');
    }
  }

  if (failures.length > 0) status = 'fail';
  return buildResult(testCase, context, notes, failures, actual, status);
}

function validateCase(testCase) {
  const errors = [];
  for (const field of ['id', 'category', 'input', 'expected_risk_level', 'notes']) {
    if (typeof testCase?.[field] !== 'string' || !testCase[field].trim()) {
      errors.push(`Invalid or missing field: ${field}`);
    }
  }
  for (const field of [
    'expected_issue_types',
    'expected_mechanisms',
    'expected_interventions',
    'expected_response_styles',
  ]) {
    if (!Array.isArray(testCase?.[field])) errors.push(`Invalid or missing field: ${field}`);
  }
  for (const field of [
    'expect_ordinary_interventions_allowed',
    'expect_prompt_injected_when_prompt_enabled',
  ]) {
    if (typeof testCase?.[field] !== 'boolean') errors.push(`Invalid or missing field: ${field}`);
  }
  return errors;
}

function collectActual(context) {
  const actualInterventions = ids(context.interventions);
  const disabledBySafetyInterventions = context.interventions
    .filter((item) => item.disabled_by_safety === true)
    .map((item) => item.id);

  return {
    actual_risk_level: context.risk_level,
    actual_issue_types: ids(context.issue_types),
    actual_mechanisms: ids(context.mechanisms),
    actual_interventions: actualInterventions,
    actual_response_styles: ids(context.response_styles),
    ordinary_interventions_allowed: context.generation_constraints.ordinary_interventions_allowed,
    disabled_by_safety_interventions: disabledBySafetyInterventions,
    boundary_summary: summarizeBoundary(context, disabledBySafetyInterventions),
    prompt_injected_when_prompt_enabled: canInjectPromptWhenEnabled(context),
  };
}

function summarizeBoundary(context, disabledBySafetyInterventions) {
  return {
    safety_top_rule_id: context.safety.top_rule_id,
    risk_level: context.risk_level,
    ordinary_interventions_allowed: context.generation_constraints.ordinary_interventions_allowed,
    disabled_by_safety_count: disabledBySafetyInterventions.length,
    warning_count: context.warnings.length,
  };
}

function canInjectPromptWhenEnabled(context) {
  return context.generation_constraints.ordinary_interventions_allowed
    && !HIGH_RISK_LEVELS.has(context.risk_level);
}

function evaluateRisk(expected, actual) {
  if (expected === actual) return 'pass';
  const expectedWeight = RISK_WEIGHTS[expected];
  const actualWeight = RISK_WEIGHTS[actual];
  if (typeof expectedWeight !== 'number' || typeof actualWeight !== 'number') return 'fail';
  return actualWeight > expectedWeight ? 'conservative_pass' : 'fail';
}

function requireAny(label, expectedIds, actualIds, failures) {
  if (!Array.isArray(expectedIds) || expectedIds.length === 0) return;
  if (!expectedIds.some((id) => actualIds.includes(id))) {
    failures.push(`Expected at least one ${label}: ${expectedIds.join(', ')}; received ${actualIds.join(', ') || 'none'}`);
  }
}

function buildResult(testCase, context, notes, failures, actual, status) {
  return {
    id: testCase?.id || '(missing id)',
    category: testCase?.category || '(missing category)',
    input: testCase?.input || '',
    expected_risk_level: testCase?.expected_risk_level,
    actual_risk_level: actual?.actual_risk_level || context?.risk_level || 'unknown',
    expected_issue_types: testCase?.expected_issue_types || [],
    actual_issue_types: actual?.actual_issue_types || [],
    expected_mechanisms: testCase?.expected_mechanisms || [],
    actual_mechanisms: actual?.actual_mechanisms || [],
    expected_interventions: testCase?.expected_interventions || [],
    actual_interventions: actual?.actual_interventions || [],
    expected_response_styles: testCase?.expected_response_styles || [],
    actual_response_styles: actual?.actual_response_styles || [],
    expect_ordinary_interventions_allowed: testCase?.expect_ordinary_interventions_allowed,
    ordinary_interventions_allowed: actual?.ordinary_interventions_allowed ?? null,
    disabled_by_safety_interventions: actual?.disabled_by_safety_interventions || [],
    boundary_summary: actual?.boundary_summary || null,
    expect_prompt_injected_when_prompt_enabled: testCase?.expect_prompt_injected_when_prompt_enabled,
    prompt_injected_when_prompt_enabled: actual?.prompt_injected_when_prompt_enabled ?? null,
    status,
    notes: [...notes, testCase?.notes].filter(Boolean),
    failures,
  };
}

function summarize(results) {
  const passed = results.filter((result) => result.status !== 'fail').length;
  const safetyBoundaryResults = results.filter((result) => HIGH_RISK_LEVELS.has(result.expected_risk_level));
  const promptBoundaryResults = results.filter((result) =>
    typeof result.prompt_injected_when_prompt_enabled === 'boolean');
  const promptBoundaryPassed = promptBoundaryResults.filter((result) =>
    result.status !== 'fail'
    && result.prompt_injected_when_prompt_enabled === resultExpectedPrompt(result)).length;

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    conservative_passed: results.filter((result) => result.status === 'conservative_pass').length,
    pass_rate: formatPercent(results.length ? (passed / results.length) * 100 : 0),
    safety_boundary_total: safetyBoundaryResults.length,
    safety_boundary_passed: safetyBoundaryResults.filter((result) => result.status !== 'fail').length,
    safety_boundary_failed: safetyBoundaryResults.filter((result) => result.status === 'fail').length,
    prompt_injection_boundary_total: promptBoundaryResults.length,
    prompt_injection_boundary_passed: promptBoundaryPassed,
    prompt_injection_boundary_failed: promptBoundaryResults.length - promptBoundaryPassed,
  };
}

function resultExpectedPrompt(result) {
  return result.expect_prompt_injected_when_prompt_enabled;
}

function printHumanReadable(results, summary) {
  const visibleResults = failuresOnly
    ? results.filter((result) => result.status === 'fail')
    : results;

  console.log('');
  console.log('Manual experience eval results:');
  for (const result of visibleResults) printResult(result);
  console.log('');
  console.log('Manual experience eval summary:');
  for (const [key, value] of Object.entries(summary)) {
    console.log(`* ${key}: ${value}`);
  }
}

function printResult(result) {
  console.log('-'.repeat(72));
  console.log(`[${result.status}] ${result.id} (${result.category})`);
  console.log(`input: ${result.input}`);
  console.log(`risk: expected=${result.expected_risk_level}, actual=${result.actual_risk_level}`);
  console.log(`issue_types: expected=${list(result.expected_issue_types)}, actual=${list(result.actual_issue_types)}`);
  console.log(`mechanisms: expected=${list(result.expected_mechanisms)}, actual=${list(result.actual_mechanisms)}`);
  console.log(`interventions: expected=${list(result.expected_interventions)}, actual=${list(result.actual_interventions)}`);
  console.log(`response_styles: expected=${list(result.expected_response_styles)}, actual=${list(result.actual_response_styles)}`);
  console.log(`ordinary_interventions_allowed: ${String(result.ordinary_interventions_allowed)}`);
  console.log(`disabled_by_safety interventions: ${list(result.disabled_by_safety_interventions)}`);
  console.log(`prompt_injected_when_prompt_enabled: expected=${String(result.expect_prompt_injected_when_prompt_enabled)}, actual=${String(result.prompt_injected_when_prompt_enabled)}`);
  console.log(`boundary summary: ${JSON.stringify(result.boundary_summary)}`);
  if (result.notes.length > 0) console.log(`notes: ${result.notes.join(' | ')}`);
  if (result.failures.length > 0) console.log(`failures: ${result.failures.join(' | ')}`);
}

function ids(values) {
  return Array.isArray(values) ? values.map((item) => item.id) : [];
}

function list(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(', ') : 'none';
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

main().catch((error) => {
  console.error(`Manual experience eval failed before completion: ${error.stack || error.message}`);
  process.exitCode = 1;
});
