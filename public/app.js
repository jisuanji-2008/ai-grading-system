/* 批阅 · AI 判分系统 — 前端逻辑（无框架，纯 DOM） */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  meta: null,
  questions: [],
  submissions: [],
  selectedQuestionId: null,
  currentSubId: null,
  view: 'create',
};

const VIEWS = {
  create: {
    eyebrow: 'TEACHER · 出题',
    title: '出题台',
    sub: '写清题干与评分标准，AI 才有可对照的尺子。',
  },
  submit: {
    eyebrow: 'STUDENT · 作答',
    title: '学生作答',
    sub: '换一份答案，分数和理由都会跟着变——这是它该有的样子。',
  },
  review: {
    eyebrow: 'TEACHER · 复核',
    title: '批改台',
    sub: 'AI 先批，人来定。改分、写备注、确认，最终成绩由教师负责。',
  },
  eval: {
    eyebrow: 'DATA · 评测',
    title: '评测报告',
    sub: '同一道题、同一套标准：AI 分与人分差多少，各自花了多久。',
  },
};

/* ── 基础工具 ─────────────────────────────── */
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (n, digits = 1) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
};

const seconds = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + 's');

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data;
}

/* ── 启动 ─────────────────────────────────── */
async function init() {
  bindGlobal();
  renderRubricRows([
    { name: '', points: '', description: '' },
    { name: '', points: '', description: '' },
  ]);
  try {
    await Promise.all([loadMeta(), loadQuestions()]);
  } catch (err) {
    toast(err.message);
  }
  route();
}

async function loadMeta() {
  const meta = await api('/api/meta');
  state.meta = meta;
  const chip = $('#modelChip');
  chip.classList.toggle('warn', !meta.keyConfigured);
  chip.innerHTML = `
    <span class="dot"></span>
    <div>
      <b>${meta.keyConfigured ? escapeHtml(meta.providerLabel) : '未配置 API Key'}</b>
      <small>${meta.keyConfigured ? escapeHtml(meta.model) : '填 .env 后重启'}</small>
    </div>`;
}

async function loadQuestions() {
  state.questions = await api('/api/questions');
  const count = $('#qCount');
  if (count) count.textContent = state.questions.length;
  renderQuestionList();
  renderQuestionSelect();
}

/* ── 路由 ─────────────────────────────────── */
function route() {
  const raw = (location.hash || '#/create').replace(/^#\//, '');
  const view = VIEWS[raw] ? raw : 'create';
  state.view = view;

  $$('.view').forEach((el) => (el.hidden = el.id !== `view-${view}`));
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));

  const cfg = VIEWS[view];
  $('#pageEyebrow').textContent = cfg.eyebrow;
  $('#pageTitle').textContent = cfg.title;
  $('#pageSub').textContent = cfg.sub;
  renderHeadActions();

  if (view === 'submit') {
    renderQuestionSelect();
    renderPromptPreview();
  }
  if (view === 'review') loadSubmissions();
  if (view === 'eval') loadEval();
  if (view === 'create') renderQuestionList();
}

function renderHeadActions() {
  const el = $('#headActions');
  if (state.view === 'create') {
    el.innerHTML = `<span class="pill">题库 ${state.questions.length} 道</span>`;
  } else if (state.view === 'submit') {
    el.innerHTML = state.meta?.keyConfigured
      ? `<span class="pill confirmed">AI 已就绪</span>`
      : `<span class="pill failed">缺少 API Key</span>`;
  } else if (state.view === 'review') {
    el.innerHTML = `<button class="btn ghost" id="refreshSubs">刷新答卷</button>`;
  } else {
    el.innerHTML = `<span class="pill">AI vs 人工</span>`;
  }
}

/* ── 出题台 ───────────────────────────────── */
function renderRubricRows(items) {
  const wrap = $('#rubricRows');
  wrap.innerHTML = items
    .map(
      (it, i) => `
      <div class="rubric-row">
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <input class="name" placeholder="评分要点，如 高效性" value="${escapeHtml(it.name || '')}" />
        <input class="pts" type="number" min="0.5" step="0.5" placeholder="分值" value="${it.points ?? ''}" />
        <input class="desc" placeholder="评分说明（可选）：写到什么程度给满分" value="${escapeHtml(it.description || '')}" />
        <button type="button" class="del" title="删除这一条">×</button>
      </div>`
    )
    .join('');
  renumberRubric();
  updateRubricTotal();
}

function renumberRubric() {
  $$('.rubric-row').forEach((row, i) => ($('.idx', row).textContent = String(i + 1).padStart(2, '0')));
}

function updateRubricTotal() {
  const total = $$('.rubric-row').reduce((sum, row) => {
    const v = Number($('.pts', row).value);
    return sum + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0);
  $('#rubricTotal').textContent = fmt(total);
}

function addRubricRow() {
  const row = document.createElement('div');
  row.className = 'rubric-row';
  row.innerHTML = `
    <span class="idx">00</span>
    <input class="name" placeholder="评分要点" />
    <input class="pts" type="number" min="0.5" step="0.5" placeholder="分值" />
    <input class="desc" placeholder="评分说明（可选）" />
    <button type="button" class="del" title="删除这一条">×</button>`;
  $('#rubricRows').appendChild(row);
  renumberRubric();
  $('.name', row).focus();
}

async function saveQuestion(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const title = form.elements['title'].value.trim();
  const subject = form.elements['subject'].value.trim();
  const prompt = form.elements['prompt'].value.trim();
  const rubric = $$('.rubric-row')
    .map((row) => ({
      name: $('.name', row).value.trim(),
      points: Number($('.pts', row).value),
      description: $('.desc', row).value.trim(),
    }))
    .filter((r) => r.name || r.points);

  if (!prompt) return toast('题干不能为空');
  if (!rubric.length) return toast('至少写一个评分要点');
  if (rubric.some((r) => !r.name)) return toast('有评分要点没写名称');
  if (rubric.some((r) => !Number.isFinite(r.points) || r.points <= 0)) return toast('分值必须大于 0');

  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try {
    const q = await api('/api/questions', { method: 'POST', body: { title, subject, prompt, rubric } });
    toast(`题目已保存，满分 ${fmt(q.maxScore)} 分`);
    form.reset();
    renderRubricRows([
      { name: '', points: '', description: '' },
      { name: '', points: '', description: '' },
    ]);
    await loadQuestions();
    state.selectedQuestionId = q.id;
    renderHeadActions();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

function renderQuestionList() {
  const wrap = $('#questionList');
  if (!wrap) return;
  if (!state.questions.length) {
    wrap.innerHTML = `<div class="empty-state" style="padding:30px 10px">
      <div class="empty-mark">题</div><p>还没有题目。<br />左边写第一道吧。</p></div>`;
    return;
  }
  wrap.innerHTML = state.questions
    .map(
      (q) => `
      <div class="q-item" data-id="${q.id}" title="点击带这道题去作答">
        <div class="q-top">
          <h4>${escapeHtml(q.title)}</h4>
          <span class="score">${fmt(q.maxScore)} 分</span>
        </div>
        <div class="meta">
          <span>${escapeHtml(q.subject || '未分学科')}</span>
          <span>${q.rubric.length} 条标准</span>
          <span>${q.submissionCount} 份答卷</span>
          <button class="q-del" data-del="${q.id}" title="删除">删除</button>
        </div>
      </div>`
    )
    .join('');
}

/* ── 学生作答 ─────────────────────────────── */
function renderQuestionSelect() {
  const sel = $('#submitQuestion');
  if (!sel) return;
  if (!state.questions.length) {
    sel.innerHTML = `<option value="">（题库为空）</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const keep = state.selectedQuestionId && state.questions.some((q) => q.id === state.selectedQuestionId)
    ? state.selectedQuestionId
    : state.questions[0].id;
  state.selectedQuestionId = keep;
  sel.innerHTML = state.questions
    .map((q) => `<option value="${q.id}" ${q.id === keep ? 'selected' : ''}>${escapeHtml(q.title)} · ${fmt(q.maxScore)} 分</option>`)
    .join('');
}

function currentQuestion() {
  return state.questions.find((q) => q.id === state.selectedQuestionId) || null;
}

function renderPromptPreview() {
  const box = $('#promptPreview');
  const q = currentQuestion();
  if (!q) {
    box.innerHTML = `<p class="muted">还没有题目，先去出题台写一道。</p>`;
    return;
  }
  box.innerHTML = `
    <strong>${escapeHtml(q.title)}</strong>
    <div style="margin-top:6px">${escapeHtml(q.prompt)}</div>
    <div class="rub">${q.rubric
      .map((c) => `<span>${escapeHtml(c.name)} · ${fmt(c.points)} 分</span>`)
      .join('')}</div>`;
}

function renderResult(sub) {
  const box = $('#gradeResult');
  box.classList.remove('is-empty');
  const d = sub.aiDetail;
  if (!d) {
    box.innerHTML = `<div class="error-box">这份答案还没有判分结果。</div>`;
    return;
  }
  const pct = Math.max(0, Math.min(1, d.total / d.maxScore));
  const C = 2 * Math.PI * 52;

  box.innerHTML = `
    <div class="result-head">
      <div class="ring">
        <svg width="116" height="116" viewBox="0 0 116 116">
          <circle class="track" cx="58" cy="58" r="52" fill="none" stroke-width="7" />
          <circle class="bar" cx="58" cy="58" r="52" fill="none" stroke-width="7"
            stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}"
            id="ringBar" />
        </svg>
        <div class="val"><b>${fmt(d.total)}</b><small>/ ${fmt(d.maxScore)} 分</small></div>
      </div>
      <div class="result-meta">
        <div class="who">${escapeHtml(sub.studentName)}</div>
        <div class="sum">${escapeHtml(d.summary)}</div>
        <div class="badges">
          <span class="badge accent">AI 初评 · 待教师确认</span>
          <span class="badge">${escapeHtml(sub.aiModel || '')}</span>
          <span class="badge">${seconds(sub.aiLatencyMs)}</span>
          <span class="badge">${sub.aiTokens || 0} tokens</span>
        </div>
      </div>
    </div>
    <div class="crit-list">
      ${d.criteria
        .map(
          (c) => `
        <div class="crit">
          <div class="crit-top">
            <span class="crit-name">${escapeHtml(c.name)}</span>
            <span class="crit-score"><b>${fmt(c.score)}</b> / ${fmt(c.points)}</span>
          </div>
          <div class="crit-track"><div class="crit-fill" style="width:${(c.score / c.points) * 100}%"></div></div>
          <div class="crit-reason">${quote(escapeHtml(c.reason))}</div>
        </div>`
        )
        .join('')}
    </div>
    <div class="feedback-grid">
      <div class="fb"><h5>答得好的地方</h5><ul>${d.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('') || '<li>—</li>'}</ul></div>
      <div class="fb"><h5>主要失分点</h5><ul>${d.gaps.map((s) => `<li>${escapeHtml(s)}</li>`).join('') || '<li>—</li>'}</ul></div>
    </div>
    <div class="form-foot">
      <span class="hint">置信度 ${(d.confidence * 100).toFixed(0)}%${d.warnings?.length ? ' · ' + d.warnings.length + ' 条校验修正' : ''}</span>
      <button class="btn ghost" data-goto-review="${sub.id}">去批改台复核 →</button>
    </div>`;

  requestAnimationFrame(() => {
    const bar = $('#ringBar');
    if (bar) bar.style.strokeDashoffset = String(C * (1 - pct));
  });
}

const quote = (html) => html.replace(/「([^」]*)」/g, '<em>「$1」</em>');

async function submitAnswer() {
  const q = currentQuestion();
  if (!q) return toast('先选一道题');
  const answer = $('#studentAnswer').value.trim();
  if (!answer) return toast('答案不能为空');
  const studentName = $('#studentName').value.trim() || '匿名学生';

  const btn = $('#submitAnswer');
  btn.disabled = true;
  const box = $('#gradeResult');
  box.classList.remove('is-empty');
  const started = Date.now();
  box.innerHTML = `
    <div class="loading-box">
      <div class="loader"></div>
      <p>AI 正在对照评分标准阅卷…</p>
      <div class="timer" id="loadTimer">0.0s</div>
      <div style="margin-top:26px">
        <div class="shimmer" style="width:70%"></div>
        <div class="shimmer" style="width:90%"></div>
        <div class="shimmer" style="width:55%"></div>
      </div>
    </div>`;
  const timer = setInterval(() => {
    const t = $('#loadTimer');
    if (t) t.textContent = ((Date.now() - started) / 1000).toFixed(1) + 's';
  }, 100);

  try {
    const sub = await api(`/api/questions/${q.id}/submissions`, {
      method: 'POST',
      body: { studentName, answer },
    });
    renderResult(sub);
    toast(`判分完成：${fmt(sub.aiScore)} / ${fmt(q.maxScore)} 分`);
    await loadQuestions();
    state.selectedQuestionId = q.id;
  } catch (err) {
    box.innerHTML = `<div class="error-box"><b>判分失败</b><br />${escapeHtml(err.message)}<br /><br />
      <span class="hint">检查 <code>.env</code> 里的 LLM_API_KEY 是否正确，然后重启服务。</span></div>`;
    toast(err.message);
  } finally {
    clearInterval(timer);
    btn.disabled = false;
  }
}

/* ── 批改台 ───────────────────────────────── */
async function loadSubmissions(preserveId) {
  try {
    state.submissions = await api('/api/submissions');
  } catch (err) {
    return toast(err.message);
  }
  const count = $('#subCount');
  if (count) count.textContent = state.submissions.length;

  const target = preserveId || state.currentSubId;
  state.currentSubId = state.submissions.some((s) => s.id === target) ? target : state.submissions[0]?.id || null;

  renderSubmissionList();
  if (state.currentSubId) renderReviewDetail(state.currentSubId);
  else {
    $('#reviewDetail').innerHTML = `<div class="empty-state">
      <div class="empty-mark">阅</div>
      <p>还没有答卷。<br />去「学生作答」提交一份，AI 批完就会出现在这里。</p></div>`;
  }
  renderHeadActions();
}

function renderSubmissionList() {
  const wrap = $('#submissionList');
  if (!wrap) return;
  if (!state.submissions.length) {
    wrap.innerHTML = `<p class="muted" style="padding:14px 10px;font-size:12px">暂无答卷</p>`;
    return;
  }
  const statusText = { pending: '排队中', graded: '待确认', confirmed: '已确认', failed: '失败' };
  wrap.innerHTML = state.submissions
    .map(
      (s) => `
      <div class="sub-item ${s.id === state.currentSubId ? 'active' : ''}" data-sub="${s.id}">
        <div class="s-top">
          <span class="s-name">${escapeHtml(s.studentName)}</span>
          <span class="s-score">${s.aiScore == null ? '—' : fmt(s.aiScore)}<small> / ${fmt(s.maxScore)}</small></span>
        </div>
        <div class="s-meta">
          <span>${escapeHtml(s.questionTitle)}</span>
        </div>
        <div class="s-meta" style="margin-top:6px">
          <span class="pill ${s.status}">${statusText[s.status] || s.status}</span>
          <span>${relTime(s.createdAt)}</span>
          ${s.status === 'confirmed' ? `<span>最终 ${fmt(s.finalScore)}</span>` : ''}
        </div>
      </div>`
    )
    .join('');
}

async function renderReviewDetail(id) {
  const box = $('#reviewDetail');
  box.innerHTML = `<div class="loading-box"><div class="loader"></div><p>读取答卷…</p></div>`;
  let sub;
  try {
    sub = await api(`/api/submissions/${id}`);
  } catch (err) {
    box.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    return;
  }
  const q = sub.question;
  const d = sub.aiDetail;
  const statusText = { pending: '排队中', graded: 'AI 已批 · 待确认', confirmed: '已确认', failed: '判分失败' };
  const score = sub.finalScore ?? sub.aiScore;
  const diff = score != null && sub.aiScore != null ? Number(score) - Number(sub.aiScore) : 0;

  box.innerHTML = `
    <div class="rd-head">
      <div>
        <h2>${escapeHtml(sub.studentName)} <span class="pill ${sub.status}" style="vertical-align:middle;margin-left:6px">${statusText[sub.status] || sub.status}</span></h2>
        <div class="sub">
          <span>${escapeHtml(q?.title || '')}</span>
          <span>提交于 ${new Date(sub.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
          ${sub.aiModel ? `<span>${escapeHtml(sub.aiModel)}</span>` : ''}
          ${sub.aiLatencyMs ? `<span>${seconds(sub.aiLatencyMs)}</span>` : ''}
        </div>
      </div>
      ${sub.status !== 'confirmed' ? `<button class="btn ghost" id="regradeBtn">重新判分</button>` : ''}
    </div>

    ${sub.status === 'failed' ? `<div class="error-box" style="margin-bottom:16px"><b>上一次判分失败</b><br />${escapeHtml(sub.aiError || '')}</div>` : ''}

    <div class="rd-grid">
      <div>
        <div class="sec-label">学生答案</div>
        <div class="answer-paper${sub.answer ? '' : ' empty'}">${escapeHtml(sub.answer || '（空白）')}</div>
        <div class="sec-label" style="margin-top:20px">评分标准</div>
        <div style="display:flex;flex-direction:column;gap:7px">
          ${(q?.rubric || [])
            .map(
              (c) => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--ink-2);padding-bottom:6px;border-bottom:1px dashed var(--line)">
                <span>${escapeHtml(c.name)}</span><span class="num" style="font-family:var(--mono);color:var(--ink-3)">${fmt(c.points)} 分</span></div>`
            )
            .join('')}
        </div>
      </div>
      <div>
        <div class="sec-label">AI 逐条给分</div>
        ${
          d
            ? `<div class="score-line"><b>${fmt(d.total)}</b><span>/ ${fmt(d.maxScore)} 分 · 置信度 ${(d.confidence * 100).toFixed(0)}%</span></div>
               <div class="crit-list">
                 ${d.criteria
                   .map(
                     (c) => `<div class="crit">
                        <div class="crit-top">
                          <span class="crit-name">${escapeHtml(c.name)}</span>
                          <span class="crit-score"><b>${fmt(c.score)}</b> / ${fmt(c.points)}</span>
                        </div>
                        <div class="crit-track"><div class="crit-fill" style="width:${(c.score / c.points) * 100}%"></div></div>
                        <div class="crit-reason">${quote(escapeHtml(c.reason))}</div>
                      </div>`
                   )
                   .join('')}
               </div>
               <p class="prose" style="margin-top:14px;font-size:12px">${escapeHtml(d.summary)}</p>`
            : `<p class="muted">还没有 AI 判分结果。</p>`
        }
      </div>
    </div>

    ${
      sub.status === 'confirmed'
        ? `<div class="confirmed-banner">
             <div>教师已确认成绩 · ${escapeHtml(sub.teacherNote || '无备注')}</div>
             <div><b>${fmt(sub.finalScore)}</b> <span style="font-size:11px;opacity:.7">/ ${fmt(q?.maxScore)} 分</span></div>
           </div>
           <div class="confirm-actions"><span class="hint">确认于 ${new Date(sub.confirmedAt).toLocaleString('zh-CN', { hour12: false })}</span>
             <button class="btn quiet" id="unlockBtn">重新打开批改</button></div>`
        : `<div class="confirm-box">
             <h3>教师复核</h3>
             <div class="confirm-row">
               <label class="field score"><span>最终分数</span>
                 <input id="finalScore" type="number" min="0" max="${q?.maxScore}" step="0.5" value="${score ?? ''}" />
               </label>
               <label class="field note"><span>备注（可选）</span>
                 <input id="teacherNote" placeholder="例：第二条漏了「不可逆」，扣 1 分" />
               </label>
             </div>
             <div class="confirm-actions">
               <span class="diff-tip" id="diffTip">与 AI 一致</span>
               <div style="display:flex;gap:8px">
                 <button class="btn quiet" id="acceptAi">采用 AI 分数</button>
                 <button class="btn primary" id="confirmBtn">确认成绩</button>
               </div>
             </div>
           </div>`
    }`;

  const input = $('#finalScore');
  if (input) {
    const tip = $('#diffTip');
    const update = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || sub.aiScore == null) {
        tip.textContent = '与 AI 一致';
        tip.className = 'diff-tip zero';
        return;
      }
      const delta = Math.round((v - sub.aiScore) * 10) / 10;
      tip.textContent = delta === 0 ? '与 AI 一致' : `比 AI ${delta > 0 ? '高' : '低'} ${Math.abs(delta)} 分`;
      tip.className = 'diff-tip' + (delta === 0 ? ' zero' : '');
    };
    input.addEventListener('input', update);
    update();

    $('#acceptAi').addEventListener('click', () => {
      input.value = sub.aiScore;
      update();
      input.focus();
    });

    $('#confirmBtn').addEventListener('click', async () => {
      const finalScore = Number(input.value);
      if (!Number.isFinite(finalScore)) return toast('请填一个有效分数');
      if (finalScore < 0 || finalScore > (q?.maxScore || 0)) return toast(`分数需在 0 ~ ${fmt(q?.maxScore)} 之间`);
      const btn = $('#confirmBtn');
      btn.disabled = true;
      try {
        await api(`/api/submissions/${sub.id}/confirm`, {
          method: 'PATCH',
          body: { finalScore, teacherNote: $('#teacherNote').value.trim() },
        });
        toast(`已确认：${fmt(finalScore)} 分`);
        await loadSubmissions(sub.id);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
  }

  const unlock = $('#unlockBtn');
  if (unlock) {
    unlock.addEventListener('click', async () => {
      unlock.disabled = true;
      try {
        await api(`/api/submissions/${sub.id}/reopen`, { method: 'POST' });
        toast('已重新打开，可再次改分');
        await loadSubmissions(sub.id);
      } catch (err) {
        toast(err.message);
        unlock.disabled = false;
      }
    });
  }

  const regrade = $('#regradeBtn');
  if (regrade) {
    regrade.addEventListener('click', async () => {
      regrade.disabled = true;
      regrade.textContent = '重判中…';
      try {
        await api(`/api/submissions/${sub.id}/regrade`, { method: 'POST' });
        toast('已重新判分');
        await loadSubmissions(sub.id);
      } catch (err) {
        toast(err.message);
        regrade.disabled = false;
        regrade.textContent = '重新判分';
      }
    });
  }
}

/* ── 评测报告 ─────────────────────────────── */
async function loadEval() {
  const box = $('#evalBody');
  box.innerHTML = `<div class="loading-box"><div class="loader"></div><p>读取评测数据…</p></div>`;
  let data;
  try {
    data = await api('/api/eval');
  } catch (err) {
    box.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!data.available) {
    box.innerHTML = `
      <div class="card" style="text-align:center;padding:56px 30px">
        <div class="empty-mark" style="margin-bottom:18px">测</div>
        <h2 style="font-size:16px;margin-bottom:10px">还没有评测数据</h2>
        <p class="prose" style="max-width:520px;margin:0 auto 20px">
          在项目目录执行 <code>npm run eval</code>，脚本会用同一道题跑 6 份答案，
          对比 AI 分与人工分，并记录每份耗时，结果会写进这张报告。
        </p>
        <pre style="display:inline-block;text-align:left;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:14px 18px;font-family:var(--mono);font-size:12px;line-height:1.8">cp .env.example .env   # 填入 LLM_API_KEY
npm run eval</pre>
      </div>`;
    return;
  }

  const m = data.metrics;
  box.innerHTML = `
    <div class="eval-hero">
      <div>
        <div class="sec-label">评测时间</div>
        <div style="font-size:13px;color:var(--ink-2)">${new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false })}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span class="badge">${escapeHtml(data.model)}</span>
        <span class="badge">样本 n=${m.n}</span>
        <span class="badge">满分 ${fmt(data.question.maxScore)}</span>
        <span class="badge">温度 ${data.temperature}</span>
      </div>
    </div>

    <div class="eval-metrics">
      <div class="metric hi">
        <div class="k">平均绝对误差 MAE</div>
        <div class="v">${fmt(m.mae, 2)}<small>分</small></div>
        <div class="d">AI 分与人工分之差绝对值的平均，满分 ${fmt(data.question.maxScore)} 分</div>
      </div>
      <div class="metric ok">
        <div class="k">±1 分以内</div>
        <div class="v">${(m.within1Rate * 100).toFixed(0)}<small>%</small></div>
        <div class="d">${m.within1} / ${m.n} 份答案 AI 与人工差距不超过 1 分</div>
      </div>
      <div class="metric">
        <div class="k">AI 平均耗时</div>
        <div class="v">${(m.avgAiLatencyMs / 1000).toFixed(1)}<small>秒/份</small></div>
        <div class="d">接口往返 + 模型推理，实测值</div>
      </div>
      <div class="metric">
        <div class="k">人工平均耗时</div>
        <div class="v">${m.avgHumanSeconds ? fmt(m.avgHumanSeconds, 1) : '—'}<small>秒/份</small></div>
        <div class="d">逐份阅读、打分、写评语的实测用时${m.speedup ? ` · AI 快 ${fmt(m.speedup)} 倍` : ''}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>逐份对照</h2><span class="hint">条形为 AI 得分，竖线为人工分</span></div>
      <table class="table">
        <thead>
          <tr>
            <th style="width:34px">#</th>
            <th>答卷</th>
            <th style="width:150px">AI / 人工</th>
            <th style="width:64px">差值</th>
            <th style="width:86px">AI 耗时</th>
            <th>AI 总评</th>
          </tr>
        </thead>
        <tbody>
          ${data.samples
            .map(
              (s, i) => `
            <tr>
              <td class="num" style="color:var(--ink-3)">${String(i + 1).padStart(2, '0')}</td>
              <td>
                <div class="name">${escapeHtml(s.studentName)}</div>
                <div style="font-size:10.5px;color:var(--ink-3);margin-top:3px">${escapeHtml(s.answerPreview)}</div>
              </td>
              <td class="bar-cell">
                <div class="mini-bar">
                  <span class="num" style="color:var(--accent)">${fmt(s.aiScore)}</span>
                  <div class="track">
                    <div class="fill" style="width:${(s.aiScore / data.question.maxScore) * 100}%"></div>
                    <div class="mark" style="left:${(s.humanScore / data.question.maxScore) * 100}%"></div>
                  </div>
                  <span class="num">${fmt(s.humanScore)}</span>
                </div>
              </td>
              <td class="num delta ${s.diff > 0 ? 'up' : s.diff < 0 ? 'down' : 'zero'}">${s.diff > 0 ? '+' : ''}${fmt(s.diff)}</td>
              <td class="num">${seconds(s.aiLatencyMs)}</td>
              <td style="font-size:11.5px;color:var(--ink-2);line-height:1.6">${escapeHtml(s.summary)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="chart-grid">
      <div class="card chart-box">
        <div class="card-head"><h2>分数对照</h2>
          <div class="legend"><span><i style="background:var(--accent)"></i>AI</span><span><i style="background:var(--ink-3)"></i>人工</span></div>
        </div>
        ${scoreChart(data)}
      </div>
      <div class="card chart-box">
        <div class="card-head"><h2>耗时对照</h2><span class="hint">AI 接口往返 vs 人工批改</span></div>
        ${latencyChart(data)}
      </div>
    </div>

    <div class="card" style="margin-top:22px">
      <div class="card-head"><h2>结论与局限</h2><span class="hint">写报告可直接引用</span></div>
      <div class="prose">
        <h3>怎么测的</h3>
        <p>同一道题、同一套评分标准，准备 ${m.n} 份质量从满分到零分的答案。先由人按标准逐条打分得到人工分，再把同样的答案交给系统判分；两次评分互不参考，最后比对差值。</p>
        <h3>结果</h3>
        <p>AI 平均绝对误差 <strong>${fmt(m.mae, 2)} 分</strong>（满分 ${fmt(data.question.maxScore)}），
        ${m.within1} / ${m.n} 份在 ±1 分以内，完全一致 ${m.exact} 份，皮尔逊相关系数 <strong>r = ${fmt(m.pearson, 2)}</strong>。
        单份判分平均 <strong>${(m.avgAiLatencyMs / 1000).toFixed(1)} 秒</strong>${m.avgHumanSeconds ? `，人工平均 <strong>${fmt(m.avgHumanSeconds, 1)} 秒</strong>，约 ${fmt(m.speedup)} 倍差距` : ''}。</p>
        <h3>这套系统的局限</h3>
        <ul>
          <li>样本只有 ${m.n} 份、单一题目，属于小样本验证，不能等同于大规模阅卷精度。</li>
          <li>人工基准由一名评阅人给出，不同教师的宽严尺度会带来 1 分左右的天然差异。</li>
          <li>模型对「表述不同但意思正确」的答案偶尔偏严，所以产品上保留了教师改分与确认环节。</li>
        </ul>
      </div>
    </div>`;
}

function scoreChart(data) {
  const W = 460, H = 210, padL = 30, padB = 26, padT = 10;
  const max = data.question.maxScore;
  const n = data.samples.length;
  const slot = (W - padL - 12) / n;
  const bw = Math.min(16, slot / 3.2);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((p) => {
      const gy = y(max * p);
      return `<line x1="${padL}" y1="${gy}" x2="${W - 6}" y2="${gy}" stroke="#e4ded1" stroke-width="1" stroke-dasharray="${p === 0 ? '0' : '2 4'}"/>
        <text x="${padL - 8}" y="${gy + 3.5}" text-anchor="end" font-size="9" fill="#8b8478" font-family="monospace">${fmt(max * p)}</text>`;
    })
    .join('');
  const bars = data.samples
    .map((s, i) => {
      const cx = padL + slot * i + slot / 2;
      const ah = H - padB - y(s.aiScore);
      const hh = H - padB - y(s.humanScore);
      return `
        <rect x="${cx - bw - 2}" y="${y(s.aiScore)}" width="${bw}" height="${Math.max(0, ah)}" rx="2" fill="#a8322b" opacity="0.9"/>
        <rect x="${cx + 2}" y="${y(s.humanScore)}" width="${bw}" height="${Math.max(0, hh)}" rx="2" fill="#8b8478" opacity="0.45"/>
        <text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#8b8478" font-family="monospace">${escapeHtml(s.tag || 'S' + (i + 1))}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${grid}${bars}</svg>`;
}

function latencyChart(data) {
  const W = 460, rowH = 30, padT = 6;
  const H = padT * 2 + rowH * data.samples.length;
  const labelW = 58, maxMs = Math.max(...data.samples.map((s) => s.aiLatencyMs), 1000);
  const rows = data.samples
    .map((s, i) => {
      const yy = padT + i * rowH;
      const w = ((W - labelW - 60) * s.aiLatencyMs) / maxMs;
      return `
        <text x="0" y="${yy + 14}" font-size="9.5" fill="#57524a" font-family="monospace">${escapeHtml(s.studentName.slice(0, 4))}</text>
        <rect x="${labelW}" y="${yy + 4}" width="${w}" height="12" rx="3" fill="#2c5f5a" opacity="0.75"/>
        <text x="${labelW + w + 6}" y="${yy + 14}" font-size="9.5" fill="#8b8478" font-family="monospace">${seconds(s.aiLatencyMs)}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${rows}</svg>`;
}

/* ── 事件绑定 ─────────────────────────────── */
function bindGlobal() {
  window.addEventListener('hashchange', route);

  $('#addCriterion').addEventListener('click', addRubricRow);
  $('#questionForm').addEventListener('submit', saveQuestion);

  $('#rubricRows').addEventListener('input', (e) => {
    if (e.target.classList.contains('pts')) updateRubricTotal();
  });
  $('#rubricRows').addEventListener('click', (e) => {
    if (!e.target.classList.contains('del')) return;
    if ($$('.rubric-row').length <= 1) return toast('至少保留一条评分标准');
    e.target.closest('.rubric-row').remove();
    renumberRubric();
    updateRubricTotal();
  });

  $('#questionList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      if (!confirm('删除这道题会同时删除它的答卷，确定？')) return;
      try {
        await api(`/api/questions/${del.dataset.del}`, { method: 'DELETE' });
        toast('题目已删除');
        if (state.selectedQuestionId === del.dataset.del) state.selectedQuestionId = null;
        await loadQuestions();
        renderHeadActions();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    const item = e.target.closest('.q-item');
    if (!item) return;
    state.selectedQuestionId = item.dataset.id;
    location.hash = '#/submit';
  });

  $('#submitQuestion').addEventListener('change', (e) => {
    state.selectedQuestionId = e.target.value;
    renderPromptPreview();
  });
  $('#studentAnswer').addEventListener('input', (e) => {
    $('#charCount').textContent = e.target.value.trim().length + ' 字';
  });
  $('#submitAnswer').addEventListener('click', submitAnswer);

  $('#headActions').addEventListener('click', (e) => {
    if (e.target.id === 'refreshSubs') {
      loadSubmissions();
      toast('已刷新');
    }
  });

  $('#submissionList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-sub]');
    if (!item) return;
    state.currentSubId = item.dataset.sub;
    renderSubmissionList();
    renderReviewDetail(state.currentSubId);
  });

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto-review]');
    if (!go) return;
    state.currentSubId = go.dataset.gotoReview;
    location.hash = '#/review';
  });
}

init();
