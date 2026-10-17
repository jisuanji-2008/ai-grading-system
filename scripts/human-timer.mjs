#!/usr/bin/env node
/**
 * 人工批改计时器：按顺序显示 6 份答案，输入你给的分数，自动记录每份用时。
 * 用法：npm run timer
 * 结果写入 eval/human-timing.json，下次 npm run eval 会自动带上人工耗时。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_DIR = path.join(ROOT, 'eval');
const fixture = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'answers.json'), 'utf8'));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const line = () => console.log('─'.repeat(66));

async function main() {
  console.log('\n  人工批改计时器');
  console.log('  规则：读完题目和评分标准后开始。每份答案从出现到按下回车计时。');
  console.log('  输入分数后回车（可用 0.5 分刻度），输入 s 跳过本份。\n');

  const reviewer = (await ask('  你的名字（可留空）：')).trim() || '未署名';

  line();
  console.log(`  题目：${fixture.question.title}（满分 ${fixture.question.maxScore} 分）\n`);
  console.log(`  ${fixture.question.prompt.split('。')[0]}。\n`);
  console.log('  评分标准：');
  fixture.question.rubric.forEach((c, i) => {
    console.log(`   ${i + 1}. ${c.name}（${c.points} 分）— ${c.description}`);
  });
  line();
  await ask('\n  准备好了按回车开始计时…');

  const perAnswer = {};
  const notes = {};

  for (const item of fixture.answers) {
    console.clear?.();
    line();
    console.log(`  ${item.tag} · ${item.studentName}`);
    line();
    console.log('\n  ' + item.answer.split('\n').join('\n  ') + '\n');
    line();

    const started = Date.now();
    let seconds = null;
    while (seconds === null) {
      const raw = (await ask('  你给几分？ ')).trim();
      if (raw.toLowerCase() === 's') {
        seconds = null;
        break;
      }
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > fixture.question.maxScore) {
        console.log(`  请输入 0 ~ ${fixture.question.maxScore} 之间的数字`);
        continue;
      }
      seconds = Math.round((Date.now() - started) / 100) / 10;
      perAnswer[item.tag] = seconds;
      const note = (await ask('  一句话理由（可留空）：')).trim();
      if (note) notes[item.tag] = note;
    }
    if (seconds !== null) console.log(`  ✓ ${seconds.toFixed(1)}s\n`);
  }

  rl.close();

  const values = Object.values(perAnswer);
  const out = {
    reviewer,
    recordedAt: new Date().toISOString(),
    perAnswer,
    notes,
    avgSeconds: values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)) : null,
  };
  fs.writeFileSync(path.join(EVAL_DIR, 'human-timing.json'), JSON.stringify(out, null, 2));

  console.log('\n  ────────────────────────────────');
  console.log(`  记录 ${values.length} 份，平均 ${out.avgSeconds ?? '—'} 秒/份`);
  console.log('  已写入 eval/human-timing.json');
  console.log('  再跑一次 npm run eval，报告里就会带上人工耗时对比。\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
