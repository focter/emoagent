const ISSUE_TIE_PRIORITY = {
  grief_loss: 8,
  romantic_relationship: 7,
  family_pressure: 6,
  academic_stress: 5,
  work_stress: 5,
  sleep_disturbance: 4,
  procrastination: 4,
  loneliness: 4,
  interpersonal: 3,
  self_blame: 3,
  rumination: 2,
  low_energy: 1,
  anxiety: 0,
};

const DETAIL_PATTERNS = [
  /(?:持续|已经|大概|差不多|最近).{0,8}(?:天|周|星期|个月|月|年)|(?:从|自从).{0,12}(?:开始|以后|以来)/,
  /(?:睡眠|睡不着|失眠|早醒|食欲|胃口|注意力|心慌|胸闷|头疼|身体|学习|考试|工作|上班|社交|生活).{0,16}(?:影响|变化|下降|变差|出错|没法|不能|减少|增加|不好)?/,
  /(?:因为|由于|自从|发生|那次|之后|最近).{2,}/,
  /(?:朋友|同学|同事|领导|室友|对象|伴侣|父母|妈妈|爸爸|家人|导师).{2,}/,
  /(?:反复|一直|总是|每天|每次|一想到|只要|越.{1,12}越).{2,}/,
  /(?:截止|还有|只剩|明天|今晚|下周|月底).{1,12}/,
];

export function analyzeUserMessage(knowledge, userMessage, context = {}) {
  const currentText = normalizeText(userMessage);
  const historyText = getHistoryText(context);
  const issueScores = knowledge.issueTypes.issue_types
    .map((issue) => ({ item: issue, score: scoreItem(issue, currentText, historyText) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score
      || (ISSUE_TIE_PRIORITY[b.item.id] || 0) - (ISSUE_TIE_PRIORITY[a.item.id] || 0));
  const selectedIssues = issueScores.slice(0, 2).map(({ item }) => item);

  const detailScore = getDetailScore(userMessage, knowledge.questionStrategy);
  const isExactVagueExpression = knowledge.questionStrategy.vague_detection.vague_expressions
    .some((expression) => normalizeText(expression) === currentText);
  const isVague = isExactVagueExpression || detailScore < 2;

  if (isVague) {
    return { isVague, detailScore, issueTypes: selectedIssues, mechanisms: [], interventions: [] };
  }

  const mechanismScores = knowledge.mechanisms.mechanisms
    .map((mechanism) => ({
      item: mechanism,
      score: scoreItem(mechanism, currentText, historyText)
        + getMechanismRelationshipScore(mechanism, selectedIssues),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const selectedMechanisms = mechanismScores.slice(0, 2).map(({ item }) => item);

  const interventionScores = knowledge.interventions.interventions
    .map((intervention) => ({
      item: intervention,
      score: scoreItem(intervention, currentText, historyText)
        + getInterventionRelationshipScore(intervention, selectedIssues, selectedMechanisms),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));

  return {
    isVague,
    detailScore,
    issueTypes: selectedIssues,
    mechanisms: selectedMechanisms,
    interventions: interventionScores.slice(0, 1).map(({ item }) => item),
  };
}

export function buildSystemPrompt(knowledge, userMessage, context = {}) {
  const analysis = context.analysis || analyzeUserMessage(knowledge, userMessage, context);
  const responseRules = knowledge.responseRules;
  const questionStrategy = knowledge.questionStrategy.information_insufficient;
  const issueGuidance = analysis.issueTypes.length
    ? analysis.issueTypes.map(formatIssue).join('\n\n')
    : '没有可靠的问题类型匹配。保持开放，不强行归类。';

  const conversationGuidance = analysis.isVague
    ? [
        '当前信息较笼统：先承接感受，不展开机制解释，也不急着给建议。',
        `本轮必须提出 ${questionStrategy.preferred_question_count} 个自然追问，并用问号结尾；不要只共情后结束。`,
        `最多追问 ${questionStrategy.max_questions} 个问题，优先只问 ${questionStrategy.preferred_question_count} 个。`,
        `追问原则：${questionStrategy.principles.slice(0, 3).join('；')}`,
        `可优先使用已匹配问题类型的 first_followups；不要重复用户已经说过的信息。`,
        '适合的追问方向包括：这种状态大概持续多久了？最近睡眠、食欲、学习工作或生活节奏有没有明显变化？',
      ].join('\n')
    : [
        '信息已足够做轻度、暂定的心理教育式理解；明确保留不确定性，不做诊断。',
        '本轮最多提出 1 个自然追问；如果已经给出一个可选小步骤，就不要再连续提问。',
        '不要替用户连续推演很多可能原因；只保留最贴近用户原话的一到两个观察。',
        analysis.mechanisms.length
          ? `最多参考以下 ${analysis.mechanisms.length} 个相关机制，只用日常语言表达：\n${analysis.mechanisms.map(formatMechanism).join('\n\n')}`
          : '没有可靠的机制匹配，不要强行解释。',
        analysis.interventions.length
          ? `本轮最多提供以下 1 个可选微干预；先判断用户是否需要建议：\n${formatIntervention(analysis.interventions[0])}`
          : '本轮没有可靠的微干预匹配，继续澄清或倾听。',
      ].join('\n\n');

  return `你是“听见”网页中的 AI 心理健康觉察对话助手。你的任务是帮助用户把情绪、压力、困扰和身心变化表达清楚，并在信息足够时提供有边界的心理教育和自助建议。

安全优先级：安全风险高于下方所有普通规则。若上下文出现消极生存意愿、自伤、自杀、伤人、明确计划、工具、即时失控、暴力威胁或无法维持基本生活，立即停止普通分析和微干预，转为确认当下安全、联系现实支持和紧急服务。不得让用户只依赖 AI。

身份边界：
${responseRules.boundaries.map((rule) => `- ${rule}`).join('\n')}

表达规则：
${responseRules.style.map((rule) => `- ${rule}`).join('\n')}
- 使用简体中文，像自然对话，不展示内部分类、匹配分数或知识库结构。
- 不机械使用“问题分析”“心理机制”“行动建议”等报告式标题。
- 回答要克制：通常 2 到 3 个短段落，总长度优先控制在 700 个中文字符以内。
- 全文问号数量最多 2 个；不要用连续反问替用户解释心理活动。

禁止表达：
${responseRules.prohibited.map((rule) => `- ${rule}`).join('\n')}

本轮匹配的问题方向（仅作组织回答的暂定线索，不是诊断）：
${issueGuidance}

本轮回应策略：
${conversationGuidance}

行动约束：
${responseRules.action_rules.map((rule) => `- ${rule}`).join('\n')}
- 微干预只能表述为可选的心理教育或自助尝试，不得写成治疗方案，不承诺效果。

只使用上面已检索出的当前相关条目。不要补充、罗列或暗示未注入的知识库内容。`;
}

function getMechanismRelationshipScore(mechanism, issues) {
  let score = 0;
  issues.forEach((issue, issueIndex) => {
    const explicitIndex = issue.common_mechanisms.indexOf(mechanism.id);
    if (explicitIndex >= 0) score += Math.max(3, 9 - explicitIndex * 2 - issueIndex * 2);
    if (mechanism.related_issue_types.includes(issue.id)) score += issueIndex === 0 ? 4 : 2;
  });
  return score;
}

function getInterventionRelationshipScore(intervention, issues, mechanisms) {
  let score = 0;
  issues.forEach((issue, issueIndex) => {
    const index = issue.possible_interventions.indexOf(intervention.id);
    if (index >= 0) score += Math.max(3, 8 - index * 2 - issueIndex);
  });
  mechanisms.forEach((mechanism, mechanismIndex) => {
    if (mechanism.related_interventions.includes(intervention.id)) score += mechanismIndex === 0 ? 5 : 2;
  });
  return score;
}

function scoreItem(item, currentText, historyText) {
  const keywords = Array.isArray(item.keywords) ? item.keywords : [];
  const expressions = Array.isArray(item.user_expressions) ? item.user_expressions : [];
  let score = 0;
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeText(keyword);
    if (!normalizedKeyword) continue;
    if (currentText.includes(normalizedKeyword)) score += 4;
    else if (historyText.includes(normalizedKeyword)) score += 1;
  }
  for (const expression of expressions) {
    const normalizedExpression = normalizeText(expression);
    if (normalizedExpression && currentText.includes(normalizedExpression)) score += 6;
  }
  return score;
}

function getDetailScore(text, questionStrategy) {
  const compact = normalizeText(text);
  const shortLength = questionStrategy.vague_detection.short_message_length || 30;
  let score = compact.length >= shortLength ? 1 : 0;
  for (const pattern of DETAIL_PATTERNS) if (pattern.test(text)) score += 1;
  return score;
}

function getHistoryText(context) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return normalizeText(messages
    .filter((message) => message?.role === 'user')
    .slice(-4)
    .map((message) => message.content)
    .join(' '));
}

function normalizeText(text = '') {
  return String(text).toLowerCase().replace(/[\s，。！？、,.!?；;：:"“”'‘’（）()]/g, '');
}

function formatIssue(issue) {
  return [
    `方向：${issue.name}`,
    `范围：${issue.description}`,
    `优先了解：${issue.key_dimensions.slice(0, 3).join('；')}`,
    `可选追问：${issue.first_followups.slice(0, 2).join(' ')}`,
    `避免：${issue.do_not_say.slice(0, 2).join('；')}`,
  ].join('\n');
}

function formatMechanism(mechanism) {
  return [
    `机制：${mechanism.name}`,
    `通俗解释：${mechanism.plain_explanation}`,
    `自然表达参考：${mechanism.natural_response_examples[0]}`,
    `避免：${mechanism.avoid.slice(0, 2).join('；')}`,
  ].join('\n');
}

function formatIntervention(intervention) {
  return [
    `微干预：${intervention.name}`,
    `适用：${intervention.suitable_for.slice(0, 2).join('；')}`,
    `步骤：${intervention.instruction.join('；')}`,
    `自然邀请：${intervention.natural_prompt}`,
    `安全边界：${intervention.safety_notes.join('；')}`,
  ].join('\n');
}
