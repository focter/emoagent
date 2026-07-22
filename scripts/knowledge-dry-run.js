import { loadKnowledge } from '../src/knowledge/knowledgeLoader.js';
import { matchKnowledge } from '../src/knowledge/knowledgeMatcher.js';
import { buildKnowledgeContext } from '../src/knowledge/knowledgeContextBuilder.js';

const examples = [
  '我论文写不完了，感觉自己完蛋了',
  '我最近总是睡不着，越想越焦虑',
  '我不想活了，但我还没有具体计划',
  '我已经准备好了方法，今晚就不想撑了',
  '我只是有点累，不想和别人说话',
  '我一直刷手机，明知道该做但就是开始不了',
];
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const examplesMode = args.includes('--examples');
const contextMode = args.includes('--context');
const text = args
  .filter((argument) => argument !== '--json' && argument !== '--examples' && argument !== '--context')
  .join(' ')
  .trim();

try {
  const knowledge = loadKnowledge();
  if (examplesMode) {
    const results = examples.map((example) => {
      const result = matchKnowledge(knowledge, { text: example });
      return contextMode ? buildKnowledgeContext(result, { knowledge }) : result;
    });
    if (jsonMode) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      results.forEach((result, index) => {
        if (index > 0) console.log('\n' + '='.repeat(72) + '\n');
        if (contextMode) printContextHumanReadable(result);
        else printHumanReadable(result);
      });
    }
  } else if (text) {
    const result = matchKnowledge(knowledge, { text });
    if (contextMode) {
      const context = buildKnowledgeContext(result, { knowledge });
      if (jsonMode) console.log(JSON.stringify(context, null, 2));
      else printContextHumanReadable(context);
    } else if (jsonMode) console.log(JSON.stringify(result, null, 2));
    else printHumanReadable(result);
  } else {
    printUsage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Knowledge dry-run failed: ${error.message}`);
  process.exitCode = 1;
}

function printHumanReadable(result) {
  console.log('Input:');
  console.log(result.input);
  console.log('');
  console.log('Safety:');
  console.log(`- top: ${formatTop(result.safety.top)}`);
  console.log(`- risk_level: ${result.safety.risk_level}`);
  console.log(`- priority: ${result.safety.priority}`);
  printMatches('matches', result.safety.matches);
  printMatches('Issue Types', result.issue_types);
  printMatches('Mechanisms', result.mechanisms);
  printMatches('Interventions', result.interventions);
  printMatches('Response Styles', result.response_styles);
  printList('Evidence refs', result.evidence_refs);
  printList('Warnings', result.warnings);
}

function printContextHumanReadable(context) {
  console.log('Knowledge Context:');
  console.log(`- risk_level: ${context.risk_level}`);
  console.log(`- priority: ${context.priority}`);
  console.log(`- safety top: ${context.safety.top_rule_id || 'none'}`);
  printIds('issue_types', context.issue_types);
  printIds('mechanisms', context.mechanisms);
  printIds('interventions', context.interventions);
  printIds('response_styles', context.response_styles);
  console.log('- constraints:');
  for (const [key, value] of Object.entries(context.generation_constraints)) {
    console.log(`  - ${key}: ${String(value)}`);
  }
  printList('warnings', context.warnings);
}

function printIds(label, values) {
  console.log(`- ${label}:`);
  if (!Array.isArray(values) || values.length === 0) {
    console.log('  - none');
    return;
  }
  for (const value of values) {
    const disabled = value.disabled_by_safety ? '; disabled_by_safety=true' : '';
    console.log(`  - ${value.id} (${value.name}${disabled})`);
  }
}

function printMatches(label, matches) {
  console.log('');
  console.log(`${label}:`);
  if (matches.length === 0) {
    console.log('- none');
    return;
  }
  for (const match of matches) {
    const details = [
      `score=${match.score}`,
      `risk=${match.risk_level}`,
      `priority=${match.priority}`,
      `review=${match.review_status}`,
    ].join(', ');
    console.log(`- ${match.id} (${match.name}; ${details})`);
    if (match.matched_keywords.length > 0) {
      console.log(`  keywords: ${match.matched_keywords.join(', ')}`);
    }
    if (match.matched_signals.length > 0) {
      console.log(`  signals: ${match.matched_signals.join(', ')}`);
    }
    if (match.matched_excludes.length > 0) {
      console.log(`  excludes: ${match.matched_excludes.join(', ')}`);
    }
  }
}

function printList(label, values) {
  console.log('');
  console.log(`${label}:`);
  if (values.length === 0) console.log('- none');
  else values.forEach((value) => console.log(`- ${value}`));
}

function formatTop(top) {
  return top
    ? `${top.id} (${top.name}; score=${top.score}, risk=${top.risk_level}, priority=${top.priority}, review=${top.review_status})`
    : 'none';
}

function printUsage() {
  console.log('Usage:');
  console.log('  npm run knowledge:dry-run -- "输入文本"');
  console.log('  npm run knowledge:dry-run -- "输入文本" --json');
  console.log('  npm run knowledge:dry-run -- "input text" --context');
  console.log('  npm run knowledge:dry-run -- "input text" --context --json');
  console.log('  npm run knowledge:dry-run -- --examples');
}
