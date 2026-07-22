export function createKnowledgeMockReply(userMessage, analysis, knowledge) {
  const primaryIssue = analysis.issueTypes[0];

  if (analysis.isVague) {
    const acknowledgement = getVagueAcknowledgement(primaryIssue);
    const questions = getFollowUpQuestions(primaryIssue, knowledge, userMessage, 2);
    return `${acknowledgement}\n\n${questions.join(' ')}`.trim();
  }

  const mechanism = analysis.mechanisms[0];
  const intervention = analysis.interventions?.[0];
  const followUp = getFollowUpQuestions(primaryIssue, knowledge, userMessage, 1)[0] || '';
  if (mechanism) {
    const explanation = mechanism.natural_response_examples[0] || mechanism.plain_explanation;
    const selfHelp = intervention
      ? `\n\n如果你现在想试一个可选的小步骤：${intervention.natural_prompt} 这只是自助尝试，不是治疗，也不保证效果。`
      : '';
    return `${explanation}${selfHelp}${followUp ? `\n\n${followUp}` : ''}`;
  }

  if (primaryIssue) {
    return `从你描述的内容看，${primaryIssue.description} 这只是当前的理解方向，不是诊断。${followUp ? `\n\n${followUp}` : ''}`;
  }

  return `我能听出这件事已经在影响你，但现有信息还不足以判断主要来自哪里。\n\n${followUp || '它目前最明显地影响了睡眠、学习工作，还是和人的相处？'}`;
}

function getVagueAcknowledgement(issue) {
  const acknowledgements = {
    low_energy: '听起来你现在像是被耗住了，连开始做事都需要不少力气。我先不把它简单归为懒或不够努力。',
    anxiety: '听起来你最近很难真正放松下来。我先不急着判断原因，想先看清担心的内容和影响。',
    self_blame: '听起来你对自己的评价很重，但现在还需要区分具体发生的事和对整个人的结论。',
    procrastination: '行动卡住不一定只是自制力问题，我先不急着给方法，想了解每次开始前发生了什么。',
    rumination: '这些想法像是一直在脑子里转，但现在还不清楚它们围绕什么、怎样影响你。',
    sleep_disturbance: '睡不好会牵动白天的精力和情绪，我先了解一下具体的睡眠变化。',
    academic_stress: '学业压力可能同时牵动任务、结果担心和作息，我先不替你判断是哪一个。',
    work_stress: '听起来工作相关的负荷已经让你很难松下来，我想先看清最主要的压力源。',
    interpersonal: '这段相处让你不太好受，但现在还需要区分具体互动、你的理解和你的需要。',
    romantic_relationship: '这段关系正在牵动你不少情绪，我先不替你判断关系该怎么办。',
    family_pressure: '来自家里的压力往往也带着现实限制，我先不急着给建议。',
    loneliness: '这种孤独或空下来的感觉值得认真看见，我也需要确认它对你意味着什么。',
  };
  return acknowledgements[issue?.id]
    || '我听见你最近不太好受，但现在不用急着给它下结论。先补一点背景，能减少误判。';
}

function getFollowUpQuestions(issue, knowledge, userMessage, limit) {
  const candidates = issue?.first_followups
    || knowledge.questionStrategy.information_insufficient.priority.map(turnPriorityIntoQuestion);
  const questions = [];
  for (const candidate of candidates) {
    const question = candidate.endsWith('？') ? candidate : turnPriorityIntoQuestion(candidate);
    if (!question || isAlreadyAnswered(question, userMessage) || questions.includes(question)) continue;
    questions.push(question);
    if (questions.length >= limit) break;
  }
  return questions;
}

function isAlreadyAnswered(question, message) {
  const durationPattern = /(?:持续|已经|大概|差不多|最近).{0,8}(?:天|周|星期|个月|月|年)|(?:从|自从).{0,12}(?:开始|以来)/;
  if (/持续多久|什么时候开始/.test(question) && durationPattern.test(message)) return true;
  if (/睡眠|食欲|白天|日常生活|影响/.test(question)
    && /睡眠|睡不着|失眠|早醒|食欲|胃口|学习|考试|工作|生活|注意力|没法|下降|出错/.test(message)) return true;
  if (/哪件|发生|互动|压力源|最紧迫|具体/.test(question)
    && /因为|由于|自从|发生|之后|考试|论文|项目|工作|出错|出了错|吵架|争执|冲突|分手|没回复|不回消息|不叫我|不打招呼|用我的东西|催我|否定/.test(message)) return true;
  if (/最担心/.test(question) && /担心|害怕|怕|最坏/.test(message)) return true;
  return false;
}

function turnPriorityIntoQuestion(priority) {
  if (/持续时间/.test(priority)) return '这种状态大概持续多久了？';
  if (/影响程度/.test(priority)) return '最近睡眠、食欲或学习工作有没有明显变化？';
  if (/情绪类型/.test(priority)) return '现在更接近焦虑、低落、烦躁、委屈，还是麻木？';
  if (/可能诱因/.test(priority)) return '最近发生了什么，让这种感觉特别明显？';
  return '这件事目前最让你难受的具体部分是什么？';
}
