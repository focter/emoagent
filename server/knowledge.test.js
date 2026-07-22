import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge } from './knowledgeLoader.js';
import { analyzeUserMessage, buildSystemPrompt } from './prompt.js';
import { createKnowledgeMockReply } from './mock.js';
import { detectHighRisk, getSafetyResponse } from './safety.js';
import { prepareChat, startServer } from './index.js';
import { auditKnowledge } from '../scripts/audit-knowledge.js';

test('loads and validates knowledge base 2.0 collections', async () => {
  const knowledge = await loadKnowledge({ forceReload: true });

  assert.equal(knowledge.version, 2);
  assert.equal(knowledge.issueTypes.issue_types.length, 13);
  assert.equal(knowledge.mechanisms.mechanisms.length, 16);
  assert.equal(knowledge.interventions.interventions.length, 10);
  assert.equal(knowledge.safety.riskLevels.length, 5);
  assert.equal(knowledge.sourceRegistry.sources.length, 7);
  assert.deepEqual(knowledge.stats, {
    issueTypes: 13,
    mechanisms: 16,
    interventions: 10,
    safetyLevels: 5,
    sources: 7,
  });
});

test('knowledge audit reports complete v2 counts without high-risk errors', async () => {
  const report = await auditKnowledge();

  assert.equal(report.counts.totalEntries, 45);
  assert.equal(report.counts.issueTypes, 13);
  assert.equal(report.counts.mechanisms, 16);
  assert.equal(report.counts.interventions, 10);
  assert.equal(report.counts.safetyLevels, 5);
  assert.equal(report.counts.entriesWithSourceReferences, 2);
  assert.equal(report.counts.entriesWithoutSourceReferences, 43);
  assert.equal(report.errors.length, 0);
  assert.equal(report.reviewDistribution.unreviewed, 45);
});

test('every v2 entry exposes the audit and required content fields', async () => {
  const knowledge = await loadKnowledge();
  for (const issue of knowledge.issueTypes.issue_types) {
    assert.ok(issue.id && issue.description && issue.source_level && issue.review_status);
    assert.ok(issue.first_followups.length > 0 && issue.common_mechanisms.length > 0);
  }
  for (const mechanism of knowledge.mechanisms.mechanisms) {
    assert.ok(mechanism.id && mechanism.plain_explanation && mechanism.source_level);
    assert.ok(mechanism.safe_small_actions.length > 0);
  }
  for (const intervention of knowledge.interventions.interventions) {
    assert.ok(intervention.id && intervention.natural_prompt && intervention.review_status);
    assert.match(intervention.safety_notes.join(''), /自助|治疗|安全|医疗/);
  }
});

test('treats a short low-energy expression as vague and asks questions in mock mode', async () => {
  const knowledge = await loadKnowledge();
  const message = '我什么都不想做';
  const analysis = analyzeUserMessage(knowledge, message);
  const reply = createKnowledgeMockReply(message, analysis, knowledge);

  assert.equal(analysis.isVague, true);
  assert.equal(analysis.issueTypes[0]?.id, 'low_energy');
  assert.equal(analysis.mechanisms.length, 0);
  assert.equal(analysis.interventions.length, 0);
  assert.match(reply, /持续多久/);
  assert.ok((reply.match(/？/g) || []).length <= 3);
});

test('selects no more than two mechanisms and one intervention for concrete input', async () => {
  const knowledge = await loadKnowledge();
  const message = '论文只剩十天，我每天拖到凌晨才开始，越拖越害怕。';
  const analysis = analyzeUserMessage(knowledge, message);

  assert.equal(analysis.isVague, false);
  assert.equal(analysis.issueTypes[0]?.id, 'procrastination');
  assert.equal(analysis.mechanisms[0]?.id, 'avoidance_loop');
  assert.equal(analysis.interventions[0]?.id, 'small_step_activation');
  assert.ok(analysis.mechanisms.length <= 2);
  assert.ok(analysis.interventions.length <= 1);
});

test('matches sleep, work, relationship and grief issue ids', async () => {
  const knowledge = await loadKnowledge();
  const workAnalysis = analyzeUserMessage(
    knowledge,
    '最近三周项目压力很大，我每天睡不着，工作注意力也明显下降了。',
  );
  const relationshipAnalysis = analyzeUserMessage(
    knowledge,
    '对象两天没回消息，我一直担心他不爱我，晚上也睡不着。',
  );
  const griefAnalysis = analyzeUserMessage(
    knowledge,
    '亲人去世已经两周，我有时很麻木，有时又突然特别悲痛，最近睡眠也受影响。',
  );

  assert.deepEqual(workAnalysis.issueTypes.map((item) => item.id), ['work_stress', 'sleep_disturbance']);
  assert.equal(workAnalysis.mechanisms[0]?.id, 'stress_response');
  assert.equal(relationshipAnalysis.issueTypes[0]?.id, 'romantic_relationship');
  assert.equal(relationshipAnalysis.interventions[0]?.id, 'fact_vs_interpretation');
  assert.equal(griefAnalysis.issueTypes[0]?.id, 'grief_loss');
  assert.equal(griefAnalysis.interventions[0]?.id, 'emotion_labeling');
});

test('mock mode uses a selected mechanism and at most one psychoeducational micro-intervention', async () => {
  const knowledge = await loadKnowledge();
  const message = '论文只剩十天，我每天拖到凌晨才开始，越拖越害怕。';
  const analysis = analyzeUserMessage(knowledge, message);
  const reply = createKnowledgeMockReply(message, analysis, knowledge);

  assert.match(reply, /不是不在意|躲开|回避|开始/);
  assert.match(reply, /自助尝试，不是治疗，也不保证效果/);
  assert.ok((reply.match(/可选的小步骤/g) || []).length <= 1);
});

test('dynamic prompt injects only selected knowledge rather than the full repository', async () => {
  const knowledge = await loadKnowledge();
  const message = '论文只剩十天，我每天拖到凌晨才开始，越拖越害怕。';
  const analysis = analyzeUserMessage(knowledge, message);
  const prompt = buildSystemPrompt(knowledge, message, { analysis });

  assert.match(prompt, /拖延 \/ 行动困难/);
  assert.match(prompt, /回避循环/);
  assert.match(prompt, /小步行为激活/);
  assert.doesNotMatch(prompt, /依恋不安全感/);
  assert.doesNotMatch(prompt, /当你没问就用我的东西时/);
  assert.ok((prompt.match(/机制：/g) || []).length <= 2);
  assert.ok((prompt.match(/微干预：/g) || []).length <= 1);
  assert.ok(prompt.length < 10_000);
});

test('vague input prompt requires a natural follow-up', async () => {
  const knowledge = await loadKnowledge();
  const message = '我最近很烦';
  const analysis = analyzeUserMessage(knowledge, message);
  const prompt = buildSystemPrompt(knowledge, message, { analysis });

  assert.equal(analysis.isVague, true);
  assert.match(prompt, /本轮必须提出 2 个自然追问/);
  assert.match(prompt, /不要只共情后结束/);
  assert.match(prompt, /用问号结尾/);
  assert.doesNotMatch(prompt, /微干预：/);
});

test('specific relationship prompt limits question count and over-analysis', async () => {
  const knowledge = await loadKnowledge();
  const message = '最近一个月朋友聚会总不叫我，我很委屈，但又不敢问，怕显得自己很在意。';
  const analysis = analyzeUserMessage(knowledge, message);
  const prompt = buildSystemPrompt(knowledge, message, { analysis });

  assert.equal(analysis.isVague, false);
  assert.equal(analysis.issueTypes[0]?.id, 'interpersonal');
  assert.match(prompt, /本轮最多提出 1 个自然追问/);
  assert.match(prompt, /不要替用户连续推演很多可能原因/);
  assert.match(prompt, /全文问号数量最多 2 个/);
  assert.match(prompt, /总长度优先控制在 700 个中文字符以内/);
});

test('warn regression cases keep explicit, relevant analysis and avoid repeated follow-ups', async () => {
  const knowledge = await loadKnowledge();
  const cases = [
    {
      message: '上周汇报出了错，我到现在还觉得都是我的错，反复想自己怎么这么没用。',
      expectedIntervention: 'fact_vs_interpretation',
      expectedReply: /这种自责可能/,
      forbiddenReply: /最近哪件具体的事/,
    },
    {
      message: '最近一个月朋友聚会总不叫我，我很委屈，但又不敢问，怕显得自己很在意。',
      expectedIntervention: 'boundary_sentence',
      expectedReply: /在这段关系里/,
      forbiddenReply: /具体发生了什么/,
    },
    {
      message: '室友连续几个月不打招呼就用我的东西，我每次都很生气，可开口时又说没关系。',
      expectedIntervention: 'boundary_sentence',
      expectedReply: /在这段关系里/,
      forbiddenReply: /两天没收到回复/,
    },
    {
      message: '父母催我结婚，对象也觉得我不够坚定，这两周我每天都很焦虑，又不敢和任何人说真实想法。',
      expectedIntervention: 'boundary_sentence',
      expectedReply: /在这段关系里/,
    },
    {
      message: '搬到新城市三个月了，下班后几乎没人说话，我越来越觉得生活很空，但我没有伤害自己的想法。',
      expectedIntervention: 'emotion_labeling',
      expectedReply: /反馈可能也会减少/,
    },
    {
      message: '和同学争执已经一周了，我每天睡前都把当时的话重放很多遍，但没有想到新办法，只是越来越后悔。',
      expectedIntervention: 'worry_time_limit',
      expectedReply: /这种反复回放/,
      forbiddenReply: /具体发生了什么/,
    },
  ];

  for (const item of cases) {
    const analysis = analyzeUserMessage(knowledge, item.message);
    const reply = createKnowledgeMockReply(item.message, analysis, knowledge);
    assert.equal(analysis.interventions[0]?.id, item.expectedIntervention);
    assert.match(reply, item.expectedReply);
    if (item.forbiddenReply) assert.doesNotMatch(reply, item.forbiddenReply);
  }
});

test('risk detection maps passive, explicit, planned and in-progress signals to levels', () => {
  assert.equal(detectHighRisk('活着没意思，我想消失').level, 'level_1');
  assert.equal(detectHighRisk('我最近总想死').level, 'level_2');
  assert.equal(detectHighRisk('我想死，已经准备了工具').level, 'level_3');
  assert.equal(detectHighRisk('我正在割腕').level, 'level_4');
  assert.equal(detectHighRisk('最近工作压力很大').level, 'level_0');
  assert.match(getSafetyResponse('level_4'), /110 或 120/);
});

test('safety-specific phrases classify correctly without technical or homework false positives', () => {
  const expectedLevels = new Map([
    ['活着好累', 'level_1'],
    ['我真的撑不住了', 'level_1'],
    ['我想消失一会儿', 'level_1'],
    ['我有时候会想伤害自己', 'level_2'],
    ['我不想活了，但还没想怎么做', 'level_2'],
    ['我已经想好怎么自杀了', 'level_3'],
    ['我准备了药', 'level_3'],
    ['我今晚可能会伤害自己', 'level_3'],
    ['我现在就在做', 'level_4'],
    ['我已经吃了很多药', 'level_4'],
    ['我控制不住自己了', 'level_4'],
    ['我控制不住想伤害别人', 'level_4'],
    ['我会划伤自己但不想死', 'level_2'],
    ['我不想说具体方法，但工具已经在手边', 'level_3'],
  ]);
  for (const [input, expectedLevel] of expectedLevels) {
    assert.equal(detectHighRisk(input).level, expectedLevel, input);
  }

  for (const input of [
    '我想杀死这个进程',
    '这个 bug 让我想死',
    '这题把我整崩了',
    '我快被作业折磨死了',
    '我没有想自杀，只是压力很大',
    '我很生气但没有想伤害别人',
    '你会不会把我的心理状态告诉老师或家长？',
    '我要 kill 这个 node 进程',
    '我割过自己，但现在没有伤害自己的想法',
  ]) {
    assert.equal(detectHighRisk(input).level, 'level_0', input);
  }
});

test('high-risk input bypasses ordinary prompt and mock construction', async () => {
  const prepared = await prepareChat([{ role: 'user', content: '我想死，已经准备了工具' }]);

  assert.equal(prepared.safety, true);
  assert.equal(prepared.riskLevel, 'level_3');
  assert.equal('systemPrompt' in prepared, false);
  assert.equal('mockReply' in prepared, false);
  assert.match(prepared.reply, /紧急/);
});

test('recent user messages are combined for safety routing', async () => {
  const prepared = await prepareChat([
    { role: 'user', content: '我不想活了，但还没想怎么做' },
    { role: 'assistant', content: '我很重视你说的这些。你现在安全吗？' },
    { role: 'user', content: '我不想说具体方法，但工具已经在手边' },
  ]);

  assert.equal(prepared.safety, true);
  assert.equal(prepared.riskLevel, 'level_3');
  assert.equal('systemPrompt' in prepared, false);
  assert.equal('mockReply' in prepared, false);
});

test('/api/health reports knowledge version 2 and v2 collection counts', async (t) => {
  const server = startServer(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.knowledge.version, 2);
  assert.equal(body.knowledge.issueTypes, 13);
  assert.equal(body.knowledge.mechanisms, 16);
  assert.equal(body.knowledge.interventions, 10);
  assert.equal(body.knowledge.safetyLevels, 5);
});
