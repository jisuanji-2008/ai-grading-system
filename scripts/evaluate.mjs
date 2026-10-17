#!/usr/bin/env node
/**
 * 端到端评测：起一个独立端口的服务 → 建题 → 逐份提交答案 → 记录 AI 分数与耗时
 * → 与人工分比对 → 写 eval/results.json 与 eval/report.md
 *
 * 用法：npm run eval
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../server/config.js';
import { PROMPT_VERSION } from '../server/grader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_DIR = path.join(ROOT, 'eval');
const DB_FILE = path.join(EVAL_DIR, 'eval.sqlite');
const PORT = Number(process.env.EVAL_PORT || 4319);
const BASE = `http://127.0.0.1:${PORT}`;

const readJson = (p, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n, d = 2) => Number(n.toFixed(d));

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

const fmt = (n, d = 1) => (Number.isFinite(Number(n)) ? Number(Number(n).toFixed(d)).toString() : '—');

async function main() {
  if (process.argv.includes('--report-only')) {
    await applyTimingOnly();
    return;
  }

  const fixture = readJson(path.join(EVAL_DIR, 'answers.json'));
  if (!fixture) {
    console.error('找不到 eval/answers.json');
    process.exit(1);
  }

  if (!config.llm.keyConfigured) {
    console.error('\n✗ 未配置 API Key，无法进行真实评测。\n');
    console.error('  1) cp .env.example .env');
    console.error('  2) 在 .env 里填写 LLM_API_KEY=sk-...');
    console.error('  3) npm run eval\n');
    process.exit(1);
  }

  // 干净的评测库
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(DB_FILE + suffix)) fs.unlinkSync(DB_FILE + suffix);
  }

  console.log(`\n  评测模型：${config.llm.providerLabel} / ${config.llm.model}`);
  console.log(`  样本数：${fixture.answers.length} 份 · 满分 ${fixture.question.maxScore}\n`);

  const server = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DB_PATH: 'eval/eval.sqlite', SEED_DEMO: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let serverLog = '';
  server.stdout.on('data', (b) => (serverLog += b.toString()));
  server.stderr.on('data', (b) => (serverLog += b.toString()));

  const stop = () => {
    if (!server.killed) server.kill();
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });

  try {
    await waitForHealth(server);

    const q = await post('/api/questions', {
      title: fixture.question.title,
      subject: fixture.question.subject,
      prompt: fixture.question.prompt,
      rubric: fixture.question.rubric,
    });
    console.log(`  已建题：${q.title}（${q.maxScore} 分，${q.rubric.length} 条标准）\n`);

    const samples = [];
    for (const [i, item] of fixture.answers.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, 3000)); // 免费档限流，放慢节奏
      const humanScore = Object.values(item.human).reduce((a, b) => a + b, 0);
      process.stdout.write(`  [${i + 1}/${fixture.answers.length}] ${item.studentName} 判分中… `);
      const t0 = Date.now();
      const res = await post(`/api/questions/${q.id}/submissions`, {
        studentName: item.studentName,
        answer: item.answer,
      });
      const wall = Date.now() - t0;
      if (res.aiScore == null) throw new Error(`「${item.studentName}」判分失败：${res.aiError}`);

      const sample = {
        tag: item.tag,
        studentName: item.studentName,
        answer: item.answer,
        answerPreview: item.answer.replace(/\s+/g, ' ').slice(0, 34) + (item.answer.length > 34 ? '…' : ''),
        humanScore: round(humanScore, 1),
        humanCriteria: item.human,
        humanNote: item.humanNote || '',
        aiScore: round(res.aiScore, 1),
        diff: round(res.aiScore - humanScore, 1),
        aiLatencyMs: res.aiLatencyMs,
        wallMs: wall,
        aiTokens: res.aiTokens,
        model: res.aiModel,
        summary: res.aiDetail.summary,
        criteria: res.aiDetail.criteria.map((c) => ({
          id: c.id,
          name: c.name,
          points: c.points,
          ai: c.score,
          human: item.human[c.id],
          evidence: c.evidence || '',
          reason: c.reason,
        })),
        warnings: res.aiDetail.warnings || [],
      };
      samples.push(sample);
      console.log(`AI ${fmt(sample.aiScore)} / 人工 ${fmt(sample.humanScore)} · ${(res.aiLatencyMs / 1000).toFixed(1)}s`);
    }

    const diffs = samples.map((s) => Math.abs(s.diff));
    const aiScores = samples.map((s) => s.aiScore);
    const humanScores = samples.map((s) => s.humanScore);

    const timing = readJson(path.join(EVAL_DIR, 'human-timing.json'));
    const humanSeconds = timing?.perAnswer || {};
    for (const s of samples) {
      if (Number.isFinite(humanSeconds[s.tag])) s.humanSeconds = Number(humanSeconds[s.tag]);
    }
    const timed = samples.filter((s) => Number.isFinite(s.humanSeconds));
    const avgHuman = timed.length ? mean(timed.map((s) => s.humanSeconds)) : null;
    const avgAi = mean(samples.map((s) => s.aiLatencyMs));

    const criterionPairs = samples.flatMap((s) => s.criteria.map((c) => [c.ai, c.human]));
    const metrics = {
      n: samples.length,
      mae: round(mean(diffs), 2),
      rmse: round(Math.sqrt(mean(samples.map((s) => s.diff ** 2))), 2),
      exact: samples.filter((s) => s.diff === 0).length,
      exactRate: round(samples.filter((s) => s.diff === 0).length / samples.length, 3),
      within1: samples.filter((s) => Math.abs(s.diff) <= 1).length,
      within1Rate: round(samples.filter((s) => Math.abs(s.diff) <= 1).length / samples.length, 3),
      maxAbsDiff: round(Math.max(...diffs), 1),
      pearson: round(pearson(aiScores, humanScores), 3),
      avgAiLatencyMs: Math.round(avgAi),
      medianAiLatencyMs: Math.round([...samples.map((s) => s.aiLatencyMs)].sort((a, b) => a - b)[Math.floor(samples.length / 2)]),
      totalAiMs: samples.reduce((a, s) => a + s.aiLatencyMs, 0),
      avgHumanSeconds: avgHuman == null ? null : round(avgHuman, 1),
      speedup: avgHuman == null ? null : round(avgHuman / (avgAi / 1000), 1),
      criterionMae: round(mean(criterionPairs.map(([a, b]) => Math.abs(a - b))), 2),
      criterionCount: criterionPairs.length,
    };

    const result = {
      generatedAt: new Date().toISOString(),
      model: config.llm.model,
      provider: config.llm.providerLabel,
      baseUrl: config.llm.baseUrl,
      temperature: config.llm.temperature,
      promptVersion: PROMPT_VERSION,
      question: {
        title: fixture.question.title,
        subject: fixture.question.subject,
        prompt: fixture.question.prompt,
        maxScore: fixture.question.maxScore,
        rubric: fixture.question.rubric,
      },
      samples,
      metrics,
      humanTiming: timing ? { reviewer: timing.reviewer || '未署名', recordedAt: timing.recordedAt } : null,
    };

    fs.writeFileSync(path.join(EVAL_DIR, 'results.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(EVAL_DIR, 'report.md'), buildReport(result));
    printSummary(result);
    console.log('\n  ✓ 已写入 eval/results.json 与 eval/report.md');
    console.log('  → 打开 http://localhost:4317 的「评测报告」页可直接查看\n');
  } finally {
    stop();
  }

  async function waitForHealth(proc) {
    for (let i = 0; i < 60; i++) {
      if (proc.exitCode !== null) throw new Error(`服务启动失败：\n${serverLog}`);
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) return;
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`服务启动超时：\n${serverLog}`);
  }

  async function post(url, body) {
    const res = await fetch(BASE + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }
}

/** 只把人工计时并入已有结果，不重新调用模型 */
async function applyTimingOnly() {
  const resultFile = path.join(EVAL_DIR, 'results.json');
  const result = readJson(resultFile);
  if (!result) {
    console.error('找不到 eval/results.json，请先跑 npm run eval');
    process.exit(1);
  }
  const timing = readJson(path.join(EVAL_DIR, 'human-timing.json'));
  if (!timing) {
    console.error('找不到 eval/human-timing.json，请先跑 npm run timer 完成一次人工计时');
    process.exit(1);
  }
  for (const s of result.samples) {
    const v = timing.perAnswer?.[s.tag];
    if (Number.isFinite(v)) s.humanSeconds = Number(v);
  }
  const timed = result.samples.filter((s) => Number.isFinite(s.humanSeconds));
  const avgHuman = timed.length ? mean(timed.map((s) => s.humanSeconds)) : null;
  result.metrics.avgHumanSeconds = avgHuman == null ? null : round(avgHuman, 1);
  result.metrics.speedup = avgHuman == null ? null : round(avgHuman / (result.metrics.avgAiLatencyMs / 1000), 1);
  result.humanTiming = { reviewer: timing.reviewer || '未署名', recordedAt: timing.recordedAt };

  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(EVAL_DIR, 'report.md'), buildReport(result));
  console.log(
    `\n  ✓ 已补入人工耗时：平均 ${result.metrics.avgHumanSeconds} 秒/份，AI 快 ${result.metrics.speedup} 倍`
  );
  console.log('  ✓ 已更新 eval/results.json 与 eval/report.md\n');
}

function buildReport(r) {  const m = r.metrics;
  const rows = r.samples
    .map(
      (s) =>
        `| ${s.tag} | ${s.studentName} | ${fmt(s.humanScore)} | ${fmt(s.aiScore)} | ${s.diff > 0 ? '+' : ''}${fmt(s.diff)} | ${(s.aiLatencyMs / 1000).toFixed(1)}s | ${s.summary} |`
    )
    .join('\n');

  const critRows = r.question.rubric
    .map((c) => {
      const pairs = r.samples.map((s) => s.criteria.find((x) => x.id === c.id)).filter(Boolean);
      const aiAvg = mean(pairs.map((p) => p.ai));
      const humanAvg = mean(pairs.map((p) => p.human));
      const hit = pairs.filter((p) => Math.abs(p.ai - p.human) <= 0.5).length;
      return `| ${c.name}（${c.points} 分） | ${fmt(humanAvg, 2)} | ${fmt(aiAvg, 2)} | ${fmt(aiAvg - humanAvg, 2)} | ${hit}/${pairs.length} |`;
    })
    .join('\n');

  const worst = [...r.samples].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0];

  return `# AI 判分系统 · 评测报告

- 生成时间：${new Date(r.generatedAt).toLocaleString('zh-CN', { hour12: false })}
- 模型：${r.model}（${r.provider}，temperature=${r.temperature}）
- Prompt 版本：${r.promptVersion || 'v1'}
- 题目：${r.question.title} · 满分 ${r.question.maxScore} 分 · ${r.question.rubric.length} 条评分标准
- 样本：${m.n} 份答案，质量覆盖满分到零分

## 一、总体一致性

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| 平均绝对误差 MAE | **${fmt(m.mae, 2)} 分** | 满分 ${r.question.maxScore} 分，即误差约 ${fmt((m.mae / r.question.maxScore) * 100, 1)}% |
| 均方根误差 RMSE | ${fmt(m.rmse, 2)} 分 | 对大误差更敏感 |
| 完全一致 | ${m.exact} / ${m.n} 份 | 占比 ${(m.exactRate * 100).toFixed(0)}% |
| 相差 ≤ 1 分 | ${m.within1} / ${m.n} 份 | 占比 ${(m.within1Rate * 100).toFixed(0)}% |
| 最大偏差 | ${fmt(m.maxAbsDiff, 1)} 分 | 出现在 ${worst.tag} ${worst.studentName} |
| 皮尔逊相关系数 | r = ${fmt(m.pearson, 2)} | AI 分与人工分的线性相关程度 |
| 单条评分点平均误差 | ${fmt(m.criterionMae, 2)} 分 | 共 ${m.criterionCount} 个评分点 |

## 二、逐份对照

| # | 学生 | 人工分 | AI 分 | 差值 | AI 耗时 | AI 总评 |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## 三、评分点层面

| 评分点 | 人工均分 | AI 均分 | 偏差 | 偏差 ≤0.5 的人数 |
| --- | --- | --- | --- | --- |
${critRows}

## 四、耗时

| 指标 | 数值 |
| --- | --- |
| AI 单份平均 | ${(m.avgAiLatencyMs / 1000).toFixed(1)} 秒 |
| AI 单份中位数 | ${(m.medianAiLatencyMs / 1000).toFixed(1)} 秒 |
| AI 判完 ${m.n} 份合计 | ${(m.totalAiMs / 1000).toFixed(1)} 秒 |
| 人工单份平均 | ${m.avgHumanSeconds ? fmt(m.avgHumanSeconds, 1) + ' 秒' : '待实测（npm run timer）'} |
| AI 相对人工 | ${m.speedup ? '约 ' + fmt(m.speedup) + ' 倍' : '—'} |

> 人工耗时口径：同一位评阅人按同一评分标准，逐份完成「读题→读答案→逐条打分→写一句话评语」的时钟计时。样本量小，仅作量级参考。

## 五、结论

1. 平均绝对误差 ${fmt(m.mae, 2)} 分（满分 ${r.question.maxScore} 分），${m.within1}/${m.n} 份落在 ±1 分内，属于"可用于初评、需教师复核"的水平。
2. 分差最大的一份是 ${worst.tag} ${worst.studentName}（人工 ${fmt(worst.humanScore)}，AI ${fmt(worst.aiScore)}）：${worst.humanNote}
3. 单份耗时从人工的分钟级降到 ${(m.avgAiLatencyMs / 1000).toFixed(1)} 秒，适合先批量初评、教师只处理有争议的答卷。

## 六、已知局限

- 样本仅 ${m.n} 份、单一题目，属于小样本验证，不能等同于大规模阅卷精度。
- 人工基准只有一名评阅人，不同教师宽严尺度天然存在约 1 分差异。
- 模型对"意思对但表述不同"的答案偶尔偏严/偏松，因此产品保留教师改分与确认环节。
- 同一份答案重复判分存在约 ±1 分的波动（temperature=${r.temperature}，已尽量压低）。本报告为一次运行的实测值，不是多次平均。

## 七、复现方式

\`\`\`bash
cp .env.example .env     # 填入 LLM_API_KEY
npm install
npm run eval             # 重新跑一遍评测
\`\`\`
`;
}

function printSummary(r) {
  const m = r.metrics;
  console.log('\n  ─────────────────────────────────');
  console.log(`  平均绝对误差  ${fmt(m.mae, 2)} 分（满分 ${r.question.maxScore}）`);
  console.log(`  ±1 分以内    ${m.within1}/${m.n}（${(m.within1Rate * 100).toFixed(0)}%）`);
  console.log(`  完全一致      ${m.exact}/${m.n}`);
  console.log(`  相关系数      r = ${fmt(m.pearson, 2)}`);
  console.log(`  AI 平均耗时   ${(m.avgAiLatencyMs / 1000).toFixed(1)}s / 份`);
  if (m.avgHumanSeconds) console.log(`  人工平均耗时  ${fmt(m.avgHumanSeconds, 1)}s / 份（约 ${fmt(m.speedup)} 倍）`);
  console.log('  ─────────────────────────────────');
}

main().catch((err) => {
  console.error('\n✗ 评测失败：', err.message, '\n');
  process.exit(1);
});
