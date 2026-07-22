import { loadKnowledge } from './knowledgeLoader.js';
import { PRIORITY_WEIGHTS, RISK_WEIGHTS } from './knowledgeTypes.js';

const HIGH_RISK_CONTEXT_WARNING = 'High-risk safety context: ordinary interventions must not be used as primary response.';
const HIGH_RISK_LEVELS = new Set(['high', 'critical']);
const LOW_OR_MEDIUM_RISK_LEVELS = new Set(['none', 'low', 'medium']);
const MAX_CONTEXT_ITEMS = 2;
const MAX_EVIDENCE_REFS = 12;

let cachedKnowledge = null;

/**
 * Build a deterministic, read-only context object from a knowledge matcher result.
 * This does not generate a reply, call a model, mutate knowledge, or route chat.
 *
 * @param {import('./knowledgeTypes.js').KnowledgeMatchResult} matcherResult
 * @param {{knowledge?: import('./knowledgeTypes.js').LoadedKnowledge}} [options]
 */
export function buildKnowledgeContext(matcherResult, options = {}) {
  if (!matcherResult || typeof matcherResult !== 'object') {
    throw new TypeError('buildKnowledgeContext requires a matcher result object');
  }

  const knowledge = options.knowledge || getCachedKnowledge();
  const cardsById = indexDecisionCards(knowledge);
  const safetyRiskLevel = matcherResult.safety?.top?.risk_level || matcherResult.safety?.risk_level || 'none';
  const safetyPriority = matcherResult.safety?.top?.priority || matcherResult.safety?.priority || 'low';
  const riskLevel = highestWeightedValue(
    collectMatches(matcherResult).map((match) => match.risk_level),
    RISK_WEIGHTS,
    safetyRiskLevel,
  );
  const priority = highestWeightedValue(
    collectMatches(matcherResult).map((match) => match.priority),
    PRIORITY_WEIGHTS,
    safetyPriority,
  );
  const highRisk = HIGH_RISK_LEVELS.has(safetyRiskLevel) || HIGH_RISK_LEVELS.has(riskLevel);
  const warnings = unique([
    ...stringArray(matcherResult.warnings),
    ...(highRisk ? [HIGH_RISK_CONTEXT_WARNING] : []),
  ]);

  return {
    input: typeof matcherResult.input === 'string' ? matcherResult.input : '',
    risk_level: riskLevel,
    priority,
    safety: buildSafetyContext(matcherResult, cardsById),
    issue_types: buildIssueTypeContexts(matcherResult.issue_types, cardsById),
    mechanisms: buildMechanismContexts(matcherResult.mechanisms, cardsById),
    interventions: buildInterventionContexts(matcherResult.interventions, cardsById, highRisk),
    response_styles: buildResponseStyleContexts(matcherResult.response_styles, cardsById),
    evidence_refs: unique(stringArray(matcherResult.evidence_refs)).slice(0, MAX_EVIDENCE_REFS),
    warnings,
    generation_constraints: {
      must_not_diagnose: true,
      must_not_claim_treatment: true,
      must_not_replace_professional_care: true,
      ordinary_interventions_allowed: LOW_OR_MEDIUM_RISK_LEVELS.has(riskLevel) && !highRisk,
    },
    review_status: 'machine_draft',
  };
}

function getCachedKnowledge() {
  cachedKnowledge ||= loadKnowledge();
  return cachedKnowledge;
}

function indexDecisionCards(knowledge) {
  return new Map((knowledge?.decisionCards || []).map((card) => [card.id, card]));
}

function collectMatches(matcherResult) {
  return [
    ...array(matcherResult.safety?.matches),
    ...array(matcherResult.issue_types),
    ...array(matcherResult.mechanisms),
    ...array(matcherResult.interventions),
    ...array(matcherResult.response_styles),
  ];
}

function highestWeightedValue(values, weights, fallback) {
  return [fallback, ...values]
    .filter((value) => typeof value === 'string' && Object.hasOwn(weights, value))
    .sort((left, right) => weights[right] - weights[left])[0] || fallback;
}

function buildSafetyContext(matcherResult, cardsById) {
  const matches = array(matcherResult.safety?.matches);
  const cards = matches.map((match) => resolveCard(match, cardsById));

  return {
    top_rule_id: matcherResult.safety?.top?.id || null,
    matched_rule_ids: unique(matches.map((match) => match.id).filter(Boolean)),
    response_goals: unique(cards.flatMap((card) => stringArray(card.response_goals))),
    allowed_actions: unique(cards.flatMap((card) => stringArray(card.allowed_actions))),
    forbidden_actions: unique(cards.flatMap((card) => stringArray(card.forbidden_actions))),
  };
}

function buildIssueTypeContexts(matches, cardsById) {
  return array(matches).slice(0, MAX_CONTEXT_ITEMS).map((match) => {
    const card = resolveCard(match, cardsById);
    return {
      id: match.id,
      name: match.name || card.name || '',
      response_goals: unique(stringArray(card.response_goals)),
      possible_mechanisms: unique(stringArray(card.possible_mechanisms)),
      recommended_interventions: unique(stringArray(card.recommended_interventions)),
    };
  });
}

function buildMechanismContexts(matches, cardsById) {
  return array(matches).slice(0, MAX_CONTEXT_ITEMS).map((match) => {
    const card = resolveCard(match, cardsById);
    return {
      id: match.id,
      name: match.name || card.name || '',
      explain_to_user: typeof card.explain_to_user === 'string' ? card.explain_to_user : '',
      suitable_interventions: unique(stringArray(card.suitable_interventions)),
    };
  });
}

function buildInterventionContexts(matches, cardsById, highRisk) {
  return array(matches).slice(0, MAX_CONTEXT_ITEMS).map((match) => {
    const card = resolveCard(match, cardsById);
    const context = {
      id: match.id,
      name: match.name || card.name || '',
      steps: unique(stringArray(card.steps)),
      max_duration_minutes: typeof card.max_duration_minutes === 'number' ? card.max_duration_minutes : null,
      unsuitable_when: unique(stringArray(card.unsuitable_when)),
    };
    if (highRisk) context.disabled_by_safety = true;
    return context;
  });
}

function buildResponseStyleContexts(matches, cardsById) {
  return array(matches).slice(0, MAX_CONTEXT_ITEMS).map((match) => {
    const card = resolveCard(match, cardsById);
    return {
      id: match.id,
      name: match.name || card.name || '',
      tone_rules: unique(stringArray(card.tone_rules)),
      length_rules: unique(stringArray(card.length_rules)),
      question_rules: unique(stringArray(card.question_rules)),
    };
  });
}

function resolveCard(match, cardsById) {
  return cardsById.get(match?.id) || match || {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ''))];
}

export { HIGH_RISK_CONTEXT_WARNING };
