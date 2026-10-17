import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS questions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    subject     TEXT NOT NULL DEFAULT '',
    prompt      TEXT NOT NULL,
    rubric_json TEXT NOT NULL,
    max_score   REAL NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id            TEXT PRIMARY KEY,
    question_id   TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    student_name  TEXT NOT NULL,
    answer        TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | graded | confirmed | failed
    ai_score      REAL,
    ai_detail     TEXT,                              -- 逐条得分 + 理由（JSON）
    ai_model      TEXT,
    ai_latency_ms INTEGER,
    ai_tokens     INTEGER,
    ai_error      TEXT,
    created_at    TEXT NOT NULL,
    graded_at     TEXT,
    final_score   REAL,
    teacher_note  TEXT,
    confirmed_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS grade_runs (
    id                TEXT PRIMARY KEY,
    submission_id     TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    model             TEXT,
    latency_ms        INTEGER,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    score             REAL,
    detail_json       TEXT,
    raw_response      TEXT,
    created_at        TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sub_question ON submissions(question_id);
  CREATE INDEX IF NOT EXISTS idx_run_sub ON grade_runs(submission_id);
`);

export const nowIso = () => new Date().toISOString();

export const newId = (prefix) =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

export function rowToQuestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    prompt: row.prompt,
    rubric: JSON.parse(row.rubric_json),
    maxScore: row.max_score,
    createdAt: row.created_at,
  };
}

export function rowToSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    questionId: row.question_id,
    studentName: row.student_name,
    answer: row.answer,
    status: row.status,
    aiScore: row.ai_score,
    aiDetail: row.ai_detail ? JSON.parse(row.ai_detail) : null,
    aiModel: row.ai_model,
    aiLatencyMs: row.ai_latency_ms,
    aiTokens: row.ai_tokens,
    aiError: row.ai_error,
    createdAt: row.created_at,
    gradedAt: row.graded_at,
    finalScore: row.final_score,
    teacherNote: row.teacher_note,
    confirmedAt: row.confirmed_at,
  };
}

export function createQuestion({ id, title, subject, prompt, rubric, maxScore }) {
  db.prepare(
    `INSERT INTO questions (id, title, subject, prompt, rubric_json, max_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, title, subject, prompt, JSON.stringify(rubric), maxScore, nowIso());
  return rowToQuestion(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
}

export function getQuestion(id) {
  return rowToQuestion(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
}

export function listQuestions() {
  const rows = db.prepare('SELECT * FROM questions ORDER BY created_at DESC').all();
  return rows.map(rowToQuestion).map((q) => {
    const stat = db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
         FROM submissions WHERE question_id = ?`
      )
      .get(q.id);
    return { ...q, submissionCount: stat.n || 0, confirmedCount: stat.confirmed || 0 };
  });
}

export function createSubmission({ id, questionId, studentName, answer }) {
  db.prepare(
    `INSERT INTO submissions (id, question_id, student_name, answer, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(id, questionId, studentName, answer, nowIso());
  return rowToSubmission(db.prepare('SELECT * FROM submissions WHERE id = ?').get(id));
}

export function getSubmission(id) {
  return rowToSubmission(db.prepare('SELECT * FROM submissions WHERE id = ?').get(id));
}

export function listSubmissions(questionId) {
  const rows = questionId
    ? db
        .prepare('SELECT * FROM submissions WHERE question_id = ? ORDER BY created_at DESC')
        .all(questionId)
    : db.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
  return rows.map(rowToSubmission);
}

export function saveGrade(submissionId, result) {
  const d = result.detail;
  db.prepare(
    `UPDATE submissions
       SET status = 'graded', ai_score = ?, ai_detail = ?, ai_model = ?,
           ai_latency_ms = ?, ai_tokens = ?, ai_error = NULL,
           graded_at = ?, final_score = NULL, teacher_note = NULL, confirmed_at = NULL
     WHERE id = ?`
  ).run(
    d.total,
    JSON.stringify(d),
    result.meta.model,
    result.meta.latencyMs,
    result.meta.totalTokens,
    nowIso(),
    submissionId
  );
  db.prepare(
    `INSERT INTO grade_runs
       (id, submission_id, model, latency_ms, prompt_tokens, completion_tokens, score, detail_json, raw_response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('run'),
    submissionId,
    result.meta.model,
    result.meta.latencyMs,
    result.meta.promptTokens,
    result.meta.completionTokens,
    d.total,
    JSON.stringify(d),
    result.raw?.slice(0, 20000) || '',
    nowIso()
  );
  return getSubmission(submissionId);
}

export function markGradeFailed(submissionId, message) {
  db.prepare(`UPDATE submissions SET status = 'failed', ai_error = ? WHERE id = ?`).run(
    String(message).slice(0, 1000),
    submissionId
  );
  return getSubmission(submissionId);
}

export function confirmSubmission(id, { finalScore, teacherNote }) {
  db.prepare(
    `UPDATE submissions
       SET status = 'confirmed', final_score = ?, teacher_note = ?, confirmed_at = ?
     WHERE id = ?`
  ).run(finalScore, teacherNote ?? '', nowIso(), id);
  return getSubmission(id);
}

export function reopenSubmission(id) {
  db.prepare(
    `UPDATE submissions
       SET status = 'graded', final_score = NULL, teacher_note = NULL, confirmed_at = NULL
     WHERE id = ?`
  ).run(id);
  return getSubmission(id);
}

export function deleteQuestion(id) {
  db.prepare('DELETE FROM questions WHERE id = ?').run(id);
}

export function getStats() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('graded','confirmed') THEN 1 ELSE 0 END) AS graded,
              SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
              SUM(CASE WHEN status = 'confirmed' AND final_score <> ai_score THEN 1 ELSE 0 END) AS adjusted,
              AVG(ai_latency_ms) AS avg_latency
       FROM submissions`
    )
    .get();
  return {
    total: row.total || 0,
    graded: row.graded || 0,
    confirmed: row.confirmed || 0,
    teacherAdjusted: row.adjusted || 0,
    avgLatencyMs: row.avg_latency ? Math.round(row.avg_latency) : null,
  };
}
