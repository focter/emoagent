import { PRIORITY_WEIGHTS, RISK_WEIGHTS } from './knowledgeTypes.js';

const HIGH_RISK_WARNING = 'High-risk safety match detected; ordinary interventions must not be used as primary response.';
const DRAFT_WARNING = 'machine_draft knowledge loaded; dry-run results are for development review only.';

/**
 * Apply deterministic card matching. It does not call a model, mutate knowledge,
 * or make a production safety decision.
 *
 * @param {import('./knowledgeTypes.js').LoadedKnowledge} knowledge
 * @param {{text: string}} input
 * @returns {import('./knowledgeTypes.js').KnowledgeMatchResult}
 */
export function matchKnowledge(knowledge, input) {
  if (!input || typeof input.text !== 'string' || !input.text.trim()) {
    throw new TypeError('matchKnowledge requires a non-empty text string');
  }
  const text = input.text.trim();
  const searchableText = expandDeterministicPhrases(text);
  const safetyMatches = matchCards(knowledge.decisionCardsByType.safety_rule, searchableText);
  const issueTypes = matchCards(knowledge.decisionCardsByType.issue_type, searchableText).slice(0, 3);
  const mechanisms = matchCards(knowledge.decisionCardsByType.mechanism, searchableText).slice(0, 3);
  const interventions = matchCards(knowledge.decisionCardsByType.intervention, searchableText).slice(0, 3);
  const responseStyles = matchCards(knowledge.decisionCardsByType.response_style, searchableText).slice(0, 2);
  const topSafety = safetyMatches[0] || null;
  const warnings = [];

  if (topSafety && (topSafety.risk_level === 'high' || topSafety.risk_level === 'critical')) {
    warnings.push(HIGH_RISK_WARNING);
  }
  if ([...safetyMatches, ...issueTypes, ...mechanisms, ...interventions, ...responseStyles]
    .some((match) => match.review_status === 'machine_draft')) {
    warnings.push(DRAFT_WARNING);
  }

  return {
    input: text,
    safety: {
      matches: safetyMatches,
      top: topSafety,
      risk_level: topSafety?.risk_level || 'none',
      priority: topSafety?.priority || 'low',
    },
    issue_types: issueTypes,
    mechanisms,
    interventions,
    response_styles: responseStyles,
    evidence_refs: collectEvidenceRefs([
      ...safetyMatches,
      ...issueTypes,
      ...mechanisms,
      ...interventions,
      ...responseStyles,
    ]),
    warnings,
  };
}

function matchCards(cards, text) {
  return cards
    .map((card) => matchCard(card, text))
    .filter((match) => match.score > 0 && match.matched_excludes.length === 0)
    .sort(compareMatches);
}

function matchCard(card, text) {
  const keywords = stringArray(card.match?.keywords);
  const signals = stringArray(card.match?.signals);
  const excludes = stringArray(card.match?.exclude);
  const matchedKeywords = keywords.filter((term) => text.includes(term));
  const matchedSignals = signals.filter((term) => text.includes(term));
  const matchedExcludes = excludes.filter((term) => text.includes(term));
  const rawScore = (matchedKeywords.length * 2) + (matchedSignals.length * 3);

  return {
    id: card.id,
    type: card.type,
    name: card.name,
    score: matchedExcludes.length > 0 ? 0 : rawScore,
    matched_keywords: matchedKeywords,
    matched_signals: matchedSignals,
    matched_excludes: matchedExcludes,
    priority: card.priority,
    risk_level: card.risk_level,
    evidence_refs: [...card.evidence_refs],
    review_status: card.review_status,
  };
}

function compareMatches(left, right) {
  return (RISK_WEIGHTS[right.risk_level] ?? -1) - (RISK_WEIGHTS[left.risk_level] ?? -1)
    || (PRIORITY_WEIGHTS[right.priority] ?? -1) - (PRIORITY_WEIGHTS[left.priority] ?? -1)
    || right.score - left.score
    || left.id.localeCompare(right.id);
}

function collectEvidenceRefs(matches) {
  return [...new Set(matches.flatMap((match) => match.evidence_refs))].sort();
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
}

// Small deterministic phrase normalization keeps matching card-driven while
// covering the required dry-run paraphrases. Matching itself remains includes-based.
function expandDeterministicPhrases(text) {
  const additions = [];
  if (/准备好(?:了)?(?:方法|手段)/u.test(text)) additions.push('已经想好怎么做');
  if (/今晚.*(?:不想撑|不想活)/u.test(text)) additions.push('今晚会伤害自己');
  if (text.includes('完蛋了')) additions.push('肯定完了');
  if (text.includes('越想越')) additions.push('一直想');
  if (/刷手机.*开始不了/u.test(text)) additions.push('一直躲着');
  return additions.length > 0 ? `${text} ${additions.join(' ')}` : text;
}

export { DRAFT_WARNING, HIGH_RISK_WARNING };
