export const DECISION_CARD_TYPES = Object.freeze([
  'safety_rule',
  'issue_type',
  'mechanism',
  'intervention',
  'response_style',
]);

export const RISK_WEIGHTS = Object.freeze({
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});

export const PRIORITY_WEIGHTS = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

/**
 * @typedef {Object} KnowledgeMatch
 * @property {string} id
 * @property {string} type
 * @property {string} name
 * @property {number} score
 * @property {string[]} matched_keywords
 * @property {string[]} matched_signals
 * @property {string[]} matched_excludes
 * @property {string} priority
 * @property {string} risk_level
 * @property {string[]} evidence_refs
 * @property {string} review_status
 */

/**
 * @typedef {Object} LoadedKnowledge
 * @property {Object[]} evidenceCards
 * @property {Object[]} decisionCards
 * @property {Record<string, Object[]>} decisionCardsByType
 */

/**
 * @typedef {Object} KnowledgeMatchResult
 * @property {string} input
 * @property {{matches: KnowledgeMatch[], top: KnowledgeMatch|null, risk_level: string, priority: string}} safety
 * @property {KnowledgeMatch[]} issue_types
 * @property {KnowledgeMatch[]} mechanisms
 * @property {KnowledgeMatch[]} interventions
 * @property {KnowledgeMatch[]} response_styles
 * @property {string[]} evidence_refs
 * @property {string[]} warnings
 */
