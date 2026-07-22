import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskLevelsPath = path.join(__dirname, 'knowledge', 'safety', 'risk_levels.json');
const crisisResponsePath = path.join(__dirname, 'knowledge', 'safety', 'crisis_response.json');
const OTHER_HARM_KEYWORDS = ['伤害别人', '伤害他人', '杀了他', '杀了她', '杀人', '想伤人'];
const FALSE_POSITIVE_PATTERNS = [
  /(?:这个|这段)?bug.{0,8}(?:让我)?想死/,
  /想杀死这个(?:进程|线程|服务|任务)/,
  /这(?:题|个作业).{0,8}(?:整崩|折磨死)/,
  /快被(?:作业|考试|bug).{0,8}(?:折磨死|逼疯)/,
];
let cachedSafetyKnowledge = null;
let cachedSignature = '';

export function detectHighRisk(text = '') {
  const { riskLevels } = getSafetyKnowledge();
  const normalizedText = normalizeText(text);
  const byId = new Map(riskLevels.map((level) => [level.id, level]));
  const keywordHits = new Map(riskLevels.map((level) => [
    level.id,
    (level.keywords || []).filter((keyword) =>
      normalizedText.includes(normalizeText(keyword))
      && !isNegated(normalizedText, keyword)
      && !isContextualHyperbole(normalizedText, keyword)),
  ]));
  const otherHarmHits = OTHER_HARM_KEYWORDS.filter((keyword) =>
    normalizedText.includes(normalizeText(keyword)) && !isNegated(normalizedText, keyword),
  );
  const explicitLevel4Hits = getExplicitLevel4Hits(normalizedText);
  const explicitLevel3Hits = getExplicitLevel3Hits(normalizedText);
  const explicitLevel2Hits = getExplicitLevel2Hits(normalizedText);

  let levelId = 'level_0';
  if (explicitLevel4Hits.length > 0
    || keywordHits.get('level_4').length > 0
    || (otherHarmHits.length > 0 && /现在|马上|控制不住/.test(text))) {
    levelId = 'level_4';
  } else if (explicitLevel3Hits.length > 0) {
    levelId = 'level_3';
  } else if (keywordHits.get('level_2').length > 0 && keywordHits.get('level_3').length > 0) {
    levelId = 'level_3';
  } else if (otherHarmHits.length > 0) {
    levelId = 'level_3';
  } else if (keywordHits.get('level_2').length > 0 || explicitLevel2Hits.length > 0) {
    levelId = 'level_2';
  } else if (keywordHits.get('level_1').length > 0) {
    levelId = 'level_1';
  }

  const matchedKeywords = [
    ...(keywordHits.get(levelId) || []),
    ...(levelId === 'level_3' ? explicitLevel3Hits : []),
    ...(levelId === 'level_4' ? explicitLevel4Hits : []),
    ...(levelId === 'level_2' ? explicitLevel2Hits : []),
    ...(levelId === 'level_3' || levelId === 'level_4' ? otherHarmHits : []),
  ];
  return {
    isHighRisk: levelId !== 'level_0',
    level: levelId,
    riskLevel: byId.get(levelId),
    matchCount: matchedKeywords.length,
    matchedKeywords: [...new Set(matchedKeywords)],
  };
}

export function getSafetyResponse(levelOrRisk = 'level_2') {
  const levelId = typeof levelOrRisk === 'string' ? levelOrRisk : levelOrRisk?.level;
  const { crisisResponse } = getSafetyKnowledge();
  return crisisResponse.templates[levelId] || crisisResponse.templates.level_2;
}

export function getSafetyTextFromMessages(messages, { maxUserMessages = 4 } = {}) {
  if (!Array.isArray(messages)) return String(messages || '');
  return messages
    .filter((message) => message?.role === 'user' && typeof message.content === 'string')
    .slice(-maxUserMessages)
    .map((message) => message.content)
    .join('\n');
}

export function getSafetyRules() {
  const { riskLevels, crisisResponse } = getSafetyKnowledge();
  return {
    version: 2,
    high_risk_keywords: riskLevels.slice(1).flatMap((level) => level.keywords || []),
    response_template: crisisResponse.templates.level_2,
    risk_levels: riskLevels,
    response_templates: crisisResponse.templates,
  };
}

function getSafetyKnowledge() {
  const signature = [riskLevelsPath, crisisResponsePath]
    .map((filePath) => {
      const fileStat = statSync(filePath);
      return `${fileStat.mtimeMs}:${fileStat.size}`;
    })
    .join('|');
  if (cachedSafetyKnowledge && signature === cachedSignature) return cachedSafetyKnowledge;

  const riskDocument = readJson(riskLevelsPath);
  const crisisResponse = readJson(crisisResponsePath);
  if (!Array.isArray(riskDocument.risk_levels) || riskDocument.risk_levels.length !== 5) {
    throw new Error(`安全知识文件 ${riskLevelsPath} 必须包含 5 个 risk_levels。`);
  }
  for (const level of riskDocument.risk_levels) {
    if (!level?.id || typeof crisisResponse.templates?.[level.id] !== 'string') {
      throw new Error(`安全知识文件缺少 ${level?.id || 'unknown'} 对应模板。`);
    }
  }
  cachedSafetyKnowledge = { riskLevels: riskDocument.risk_levels, crisisResponse };
  cachedSignature = signature;
  return cachedSafetyKnowledge;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`无法加载安全知识文件 ${filePath}：${error.message}`);
  }
}

function normalizeText(text) {
  return String(text).toLowerCase().replace(/[\s，。！？、,.!?；;：:"“”'‘’（）()]/g, '');
}

function isNegated(normalizedText, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  const index = normalizedText.indexOf(normalizedKeyword);
  if (index < 0) return false;
  const prefix = normalizedText.slice(Math.max(0, index - 6), index);
  if (/(?:没有|并没有|从没|从未|不是|并非|不会|不打算|不准备|不想|不要|不愿意)$/.test(prefix)) {
    return true;
  }
  if (normalizedKeyword.startsWith('想') && /(?:没有|并没有|从没|从未|不)$/.test(prefix)) {
    return true;
  }
  if (/^(?:伤害|杀)/.test(normalizedKeyword)
    && /(?:没有想|并没有想|不想|不会|不打算|不准备)$/.test(prefix)) {
    return true;
  }
  return false;
}

function isContextualHyperbole(normalizedText, keyword) {
  if (normalizeText(keyword) !== '想死') return false;
  return FALSE_POSITIVE_PATTERNS.some((pattern) => pattern.test(normalizedText));
}

function getExplicitLevel3Hits(normalizedText) {
  const patterns = [
    ['已经想好怎么自杀', /已经(?:想好|计划好)(?:了)?怎么(?:自杀|伤害自己)/],
    ['准备了危险工具', /准备了(?:药|刀|绳|工具)/],
    ['今晚可能伤害自己', /(?:今晚|今天晚上).{0,8}(?:伤害自己|自伤|自杀)/],
    ['危险工具在手边', /(?:工具|刀|药).{0,8}(?:在手边|在身边|在手里|手边|身边|手里)|(?:手边|身边|手里).{0,8}(?:工具|刀|药)/],
  ];
  return patterns.filter(([, pattern]) => pattern.test(normalizedText)).map(([label]) => label);
}

function getExplicitLevel2Hits(normalizedText) {
  const patterns = [
    ['可能自伤但未表达自杀计划', /(?:想|会|可能会|忍不住|准备).{0,4}(?:划伤自己|割自己|伤害自己)/],
  ];
  return patterns.filter(([, pattern]) => pattern.test(normalizedText)).map(([label]) => label);
}

function getExplicitLevel4Hits(normalizedText) {
  const hits = [];
  if (/^(?:我)?现在就在做(?:了)?$/.test(normalizedText)) hits.push('现在就在做');
  if (/已经(?:吃|吞|服)(?:了)?(?:很多|大量)?(?:药|药物)/.test(normalizedText)) {
    hits.push('已经服用大量药物');
  }
  return hits;
}
