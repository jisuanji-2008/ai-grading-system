import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { config, publicMeta } from './config.js';
import {
  createQuestion,
  createSubmission,
  getQuestion,
  getStats,
  getSubmission,
  listQuestions,
  listSubmissions,
  newId,
  saveGrade,
  markGradeFailed,
  confirmSubmission,
  reopenSubmission,
  deleteQuestion,
} from './db.js';
import { gradeAnswer } from './grader.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const execFileAsync = promisify(execFile);

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── 元信息 ────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/meta', (req, res) => {
  res.json({ ...publicMeta(), stats: getStats() });
});

// ── 题目 ──────────────────────────────────────────────────
app.get('/api/questions', (req, res) => res.json(listQuestions()));

app.post('/api/questions', (req, res) => {
  const { title, subject = '', prompt, rubric } = req.body || {};
  if (!String(prompt || '').trim()) throw httpError(400, '题干不能为空');
  if (!Array.isArray(rubric) || rubric.length === 0) throw httpError(400, '至少要有一个评分要点');

  const cleaned = rubric.map((item, i) => {
    const name = String(item?.name || '').trim();
    const points = Number(item?.points);
    if (!name) throw httpError(400, `第 ${i + 1} 个评分要点缺少名称`);
    if (!Number.isFinite(points) || points <= 0) throw httpError(400, `「${name}」的分值必须大于 0`);
    return {
      id: `c${i + 1}`,
      name,
      points: Math.round(points * 2) / 2,
      description: String(item?.description || '').trim(),
    };
  });

  const maxScore = cleaned.reduce((s, c) => s + c.points, 0);
  const question = createQuestion({
    id: newId('q'),
    title: String(title || '').trim() || '未命名题目',
    subject: String(subject || '').trim(),
    prompt: String(prompt).trim(),
    rubric: cleaned,
    maxScore,
  });
  res.status(201).json(question);
});

app.get('/api/questions/:id', (req, res) => {
  const question = getQuestion(req.params.id);
  if (!question) throw httpError(404, '题目不存在');
  res.json({ ...question, submissions: listSubmissions(question.id) });
});

app.delete('/api/questions/:id', (req, res) => {
  if (!getQuestion(req.params.id)) throw httpError(404, '题目不存在');
  deleteQuestion(req.params.id);
  res.json({ ok: true });
});

// ── 提交与判分 ────────────────────────────────────────────
app.post(
  '/api/questions/:id/submissions',
  asyncRoute(async (req, res) => {
    const question = getQuestion(req.params.id);
    if (!question) throw httpError(404, '题目不存在');

    const answer = String(req.body?.answer ?? '').trim();
    const studentName = String(req.body?.studentName || '').trim() || '匿名学生';
    if (!answer) throw httpError(400, '答案不能为空');

    const submission = createSubmission({
      id: newId('s'),
      questionId: question.id,
      studentName,
      answer,
    });

    try {
      const result = await gradeAnswer({ question, answer, studentName });
      res.status(201).json(saveGrade(submission.id, result));
    } catch (err) {
      markGradeFailed(submission.id, err.message);
      throw err;
    }
  })
);

app.get('/api/submissions', (req, res) => {
  const questionId = req.query.questionId;
  const rows = listSubmissions(questionId).map((s) => {
    const q = getQuestion(s.questionId);
    return { ...s, questionTitle: q?.title || '', maxScore: q?.maxScore || 0, subject: q?.subject || '' };
  });
  res.json(rows);
});

app.get('/api/submissions/:id', (req, res) => {
  const submission = getSubmission(req.params.id);
  if (!submission) throw httpError(404, '提交记录不存在');
  res.json({ ...submission, question: getQuestion(submission.questionId) });
});

app.post(
  '/api/submissions/:id/regrade',
  asyncRoute(async (req, res) => {
    const submission = getSubmission(req.params.id);
    if (!submission) throw httpError(404, '提交记录不存在');
    const question = getQuestion(submission.questionId);
    if (!question) throw httpError(404, '题目不存在');

    try {
      const result = await gradeAnswer({
        question,
        answer: submission.answer,
        studentName: submission.studentName,
      });
      res.json(saveGrade(submission.id, result));
    } catch (err) {
      markGradeFailed(submission.id, err.message);
      throw err;
    }
  })
);

app.patch('/api/submissions/:id/confirm', (req, res) => {
  const submission = getSubmission(req.params.id);
  if (!submission) throw httpError(404, '提交记录不存在');
  const question = getQuestion(submission.questionId);

  const finalScore = Number(req.body?.finalScore);
  if (!Number.isFinite(finalScore)) throw httpError(400, '最终分数必须是数字');
  if (finalScore < 0 || finalScore > question.maxScore) {
    throw httpError(400, `最终分数需在 0 ~ ${question.maxScore} 之间`);
  }

  const confirmed = confirmSubmission(submission.id, {
    finalScore: Math.round(finalScore * 2) / 2,
    teacherNote: String(req.body?.teacherNote || '').trim(),
  });
  res.json(confirmed);
});

app.post('/api/submissions/:id/reopen', (req, res) => {
  if (!getSubmission(req.params.id)) throw httpError(404, '提交记录不存在');
  res.json(reopenSubmission(req.params.id));
});

// ── 评测结果（由 npm run eval 生成） ───────────────────────
app.get('/api/eval', (req, res) => {
  const file = path.join(config.root, 'eval', 'results.json');
  if (!fs.existsSync(file)) return res.json({ available: false });
  res.json({ available: true, ...JSON.parse(fs.readFileSync(file, 'utf8')) });
});

// ── 人工计时（网页版人工批改，供评测对比耗时） ────────────
const FIXTURE_FILE = path.join(config.root, 'eval', 'answers.json');
const TIMING_FILE = path.join(config.root, 'eval', 'human-timing.json');

app.get('/api/timer', (req, res) => {
  if (!fs.existsSync(FIXTURE_FILE)) return res.json({ available: false });
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
  const existing = fs.existsSync(TIMING_FILE) ? JSON.parse(fs.readFileSync(TIMING_FILE, 'utf8')) : null;

  // 只给出题目与答案，不透出 AI 分数与人工基准分，避免影响评阅人判断
  res.json({
    available: true,
    question: fixture.question,
    answers: fixture.answers.map((a) => ({
      tag: a.tag,
      studentName: a.studentName,
      answer: a.answer,
      approved: Boolean(a.approved),
    })),
    recorded: existing
      ? {
          reviewer: existing.reviewer,
          recordedAt: existing.recordedAt,
          avgSeconds: existing.avgSeconds,
          count: Object.keys(existing.perAnswer || {}).length,
        }
      : null,
  });
});

app.post(
  '/api/human-timing',
  asyncRoute(async (req, res) => {
    if (!fs.existsSync(FIXTURE_FILE)) throw httpError(404, '找不到评测题包 eval/answers.json');
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
    const validTags = new Set(fixture.answers.map((a) => a.tag));
    const maxScore = fixture.question.maxScore;

    const perAnswer = {};
    const scores = {};
    const notes = {};
    for (const [tag, raw] of Object.entries(req.body?.perAnswer || {})) {
      if (!validTags.has(tag)) continue;
      const sec = Number(raw);
      if (!Number.isFinite(sec) || sec <= 0 || sec > 3600) {
        throw httpError(400, `「${tag}」的计时不合法`);
      }
      perAnswer[tag] = Math.round(sec * 10) / 10;
    }
    for (const [tag, raw] of Object.entries(req.body?.scores || {})) {
      if (!validTags.has(tag)) continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > maxScore) {
        throw httpError(400, `「${tag}」的分数需在 0 ~ ${maxScore} 之间`);
      }
      scores[tag] = Math.round(v * 2) / 2;
    }
    for (const [tag, raw] of Object.entries(req.body?.notes || {})) {
      if (!validTags.has(tag)) continue;
      const note = String(raw || '').trim();
      if (note) notes[tag] = note.slice(0, 200);
    }

    const values = Object.values(perAnswer);
    if (values.length === 0) throw httpError(400, '没有记录到任何一份的用时');

    const out = {
      reviewer: String(req.body?.reviewer || '').trim() || '未署名',
      recordedAt: new Date().toISOString(),
      source: 'web',
      perAnswer,
      scores,
      notes,
      avgSeconds: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)),
    };
    fs.writeFileSync(TIMING_FILE, JSON.stringify(out, null, 2));

    // 立刻重算报告：只并入人工耗时，不重新调用模型
    let regenerated = false;
    try {
      await execFileAsync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/evaluate.mjs', '--report-only'], {
        cwd: config.root,
        timeout: 60_000,
      });
      regenerated = true;
    } catch (err) {
      console.warn('[timer] 报告重算失败：' + err.message);
    }

    const resultsFile = path.join(config.root, 'eval', 'results.json');
    const metrics = regenerated && fs.existsSync(resultsFile)
      ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')).metrics
      : null;

    res.json({ ok: true, timing: out, reportRegenerated: regenerated, metrics });
  })
);

// ── 静态资源 ──────────────────────────────────────────────
const publicDir = path.join(config.root, 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── 错误处理 ──────────────────────────────────────────────
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || '服务器内部错误', code: err.code });
});

// ── 示例题目（首次启动写入，便于直接演示） ────────────────
function seedDemo() {
  if (!config.seedDemo) return;
  if (listQuestions().length > 0) return;
  createQuestion({
    id: 'q_demo01',
    title: '酶的特性与温度的影响',
    subject: '高中生物',
    prompt:
      '请说明酶在细胞代谢中表现出的三个特性，并解释高温与低温对酶活性影响的本质区别。',
    rubric: [
      { id: 'c1', name: '高效性', points: 2, description: '指出酶的催化效率远高于无机催化剂' },
      { id: 'c2', name: '专一性', points: 2, description: '指出一种酶只能催化一种或一类化学反应' },
      { id: 'c3', name: '作用条件温和', points: 2, description: '指出酶需要适宜的温度和 pH 才能保持活性' },
      { id: 'c4', name: '高温使酶变性失活', points: 2, description: '高温破坏酶（蛋白质）的空间结构，失活不可逆' },
      { id: 'c5', name: '低温抑制但不破坏结构', points: 2, description: '低温只降低酶活性，空间结构未破坏，回温后活性可恢复' },
    ],
    maxScore: 10,
  });
  console.log('[seed] 已写入示例题目：酶的特性与温度的影响');
}

seedDemo();

app.listen(config.port, () => {
  console.log(`\n  AI 判分系统  →  http://localhost:${config.port}`);
  console.log(`  模型：${config.llm.providerLabel} / ${config.llm.model}`);
  console.log(`  Key ：${config.llm.keyConfigured ? '已配置' : '未配置（判分会失败，请填 .env）'}\n`);
});
