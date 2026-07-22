import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISION_CARD_TYPES } from './knowledgeTypes.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(moduleDirectory, '..', '..');

/**
 * Load the local knowledge layers without modifying files or assigning behavior
 * based on review status. machine_draft cards remain explicitly marked as such.
 *
 * @param {{projectRoot?: string}} [options]
 * @returns {import('./knowledgeTypes.js').LoadedKnowledge}
 */
export function loadKnowledge(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || defaultProjectRoot);
  const evidenceRoot = path.join(projectRoot, 'knowledge', 'evidence_cards');
  const decisionRoot = path.join(projectRoot, 'knowledge', 'decision_cards');
  const evidenceIndexPath = path.join(evidenceRoot, 'index.json');
  const decisionIndexPath = path.join(decisionRoot, 'index.json');

  const evidenceCards = loadIndexedCards({
    projectRoot,
    cardRoot: evidenceRoot,
    indexPath: evidenceIndexPath,
    layerName: 'evidence',
  });
  const evidenceIds = new Set(evidenceCards.map((card) => card.id));
  const decisionCards = loadIndexedCards({
    projectRoot,
    cardRoot: decisionRoot,
    indexPath: decisionIndexPath,
    layerName: 'decision',
  });

  for (const card of decisionCards) {
    if (!Array.isArray(card.evidence_refs) || card.evidence_refs.length === 0) {
      throw new Error(`[decision:${card.id}] evidence_refs must be a non-empty array`);
    }
    for (const evidenceId of card.evidence_refs) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`[decision:${card.id}] unknown evidence_ref: ${String(evidenceId)}`);
      }
    }
  }

  const decisionCardsByType = Object.fromEntries(
    DECISION_CARD_TYPES.map((type) => [type, []]),
  );
  for (const card of decisionCards) {
    if (!Object.hasOwn(decisionCardsByType, card.type)) {
      throw new Error(`[decision:${card.id}] unsupported type: ${String(card.type)}`);
    }
    decisionCardsByType[card.type].push(card);
  }

  return deepFreeze({
    evidenceCards,
    decisionCards,
    decisionCardsByType,
  });
}

function loadIndexedCards({ projectRoot, cardRoot, indexPath, layerName }) {
  const index = readJson(indexPath, `${layerName} index`);
  if (!index || typeof index !== 'object' || Array.isArray(index) || !Array.isArray(index.cards)) {
    throw new Error(`[${layerName} index] cards must be an array`);
  }
  if (index.review_status === 'deprecated') {
    throw new Error(`[${layerName} index] deprecated knowledge cannot be loaded`);
  }

  return index.cards.map((entry, position) => {
    const label = `${layerName} index.cards[${position}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`[${label}] entry must be an object`);
    }
    if (typeof entry.id !== 'string' || !entry.id) {
      throw new Error(`[${label}] id must be a non-empty string`);
    }
    if (typeof entry.path !== 'string' || !entry.path) {
      throw new Error(`[${label}] path must be a non-empty string`);
    }
    if (entry.review_status === 'deprecated') {
      throw new Error(`[${label}] deprecated card cannot be loaded: ${entry.id}`);
    }

    const cardPath = path.resolve(projectRoot, entry.path);
    const relativeToRoot = path.relative(cardRoot, cardPath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`[${label}] path is outside ${path.relative(projectRoot, cardRoot)}`);
    }
    const card = readJson(cardPath, `${layerName}:${entry.id}`);
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error(`[${layerName}:${entry.id}] card must be an object`);
    }
    if (card.id !== entry.id) {
      throw new Error(`[${layerName}:${entry.id}] card.id does not match index.id: ${String(card.id)}`);
    }
    if (card.review_status === 'deprecated') {
      throw new Error(`[${layerName}:${entry.id}] deprecated card cannot be loaded`);
    }
    if (card.review_status !== entry.review_status) {
      throw new Error(`[${layerName}:${entry.id}] review_status does not match index`);
    }
    return card;
  });
}

function readJson(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`[${label}] file does not exist: ${filePath}`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`[${label}] invalid JSON: ${error.message}`, { cause: error });
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
