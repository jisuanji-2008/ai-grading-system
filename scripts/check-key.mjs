#!/usr/bin/env node
/**
 * Key 体检：用一道 3 分的小题真实调用一次模型，确认 Key、模型名、网络都通。
 * 用法：npm run check
 */
import { config, publicMeta } from '../server/config.js';
import { gradeAnswer } from '../server/grader.js';

const question = {
  title: '体检小题',
  subject: '通用',
  prompt: '请用一句话说明：为什么天空看起来是蓝色的？',
  maxScore: 3,
  rubric: [
    { id: 'c1', name: '提到瑞利散射', points: 2, description: '指出空气分子对短波长的蓝光散射更强' },
    { id: 'c2', name: '表述通顺', points: 1, description: '句子完整、没有明显语病' },
  ],
};

const answer = '因为空气分子对波长较短的蓝光散射更强，所以我们看到的天空是蓝色的。';

const meta = publicMeta();
console.log('\n  Key 体检');
console.log('  ─────────────────────────────');
console.log(`  服务商   ${meta.providerLabel}（${meta.provider}）`);
console.log(`  模型     ${meta.model}`);
console.log(`  接口     ${config.llm.baseUrl}`);
console.log(`  Key      ${meta.keyConfigured ? '已读取到（已隐藏）' : '未配置'}`);

if (!meta.keyConfigured) {
  console.log('\n  ✗ 没有读到 Key。请检查 .env 里的 LLM_API_KEY。');
  console.log('    还没建 .env？执行：cp .env.example .env\n');
  process.exit(1);
}

console.log('  ─────────────────────────────');
console.log('  正在真实调用一次模型…\n');

try {
  const t0 = Date.now();
  const result = await gradeAnswer({ question, answer, studentName: '体检' });
  const wall = Date.now() - t0;
  console.log(`  ✓ 调用成功，用时 ${(wall / 1000).toFixed(1)} 秒`);
  console.log(`  ✓ 得分 ${result.detail.total} / ${question.maxScore}`);
  result.detail.criteria.forEach((c) => {
    console.log(`    · ${c.name} ${c.score}/${c.points}：${c.reason}`);
  });
  console.log(`  ✓ 模型自报 ${result.meta.model}，tokens ${result.meta.totalTokens}`);
  console.log('\n  一切正常，可以跑：npm run eval\n');
} catch (err) {
  console.log(`  ✗ 调用失败：${err.message}\n`);
  if (/402|余额/.test(err.message)) {
    console.log('  账户没有余额。DeepSeek 需充值；或改用智谱免费模型：');
    console.log('  .env 中设置 LLM_PROVIDER=zhipu，LLM_API_KEY=你的智谱Key\n');
  } else if (/401|403|无效/.test(err.message)) {
    console.log('  Key 不正确或权限不足，请到服务商控制台重新创建。\n');
  } else if (/404|模型/.test(err.message)) {
    console.log('  模型名或接口地址不对，检查 LLM_MODEL / LLM_BASE_URL。\n');
  }
  process.exit(1);
}
