# 评审自查表

对照评分标准的五条，逐条给出「证据在哪、怎么现场演示」。评审前过一遍即可。

## 1. 核心流程能跑通

| 证据 | 位置 |
| --- | --- |
| 出题 → 作答 → AI 判分 → 教师改分确认，四个页面全部可用 | `http://localhost:4317` |
| 后端 API 覆盖全部流程动作 | `server/index.js` |
| 数据落库，重启不丢 | `data/grading.sqlite`（本地） |

**现场演示**：录屏脚本 `docs/demo-script.md` 就是按这条流程设计的，照走一遍即可。

## 2. AI 真的在打分，分数和理由合理

| 证据 | 位置 |
| --- | --- |
| 判分走真实模型 API（glm-4-air），不是写死的规则 | `server/grader.js` |
| 换一份答案，分数和理由跟着变：6 份答案 AI 给出 10 / 9.5 / 8 / 5.5 / 4 / 0 六档 | `eval/results.json` → `samples[].aiScore` |
| 每条得分理由都**逐字引用学生原文**，服务端校验（引用对不上或与别条重复 → 该条判 0） | `server/grader.js` 中 evidence 校验 |
| AI 对"机理说反了"的答案给 4/10 并指出"高温/低温表述相反"，理由合理 | `eval/results.json` 中 A5 苏行的 criteria |

**现场演示**：在「学生作答」页现场提交一份新答案（或改一个词再提交），展示分数与理由变化；或在「批改台」点开不同答卷对比理由。

## 3. 有 AI 和人工的对比数据

| 指标 | 数值 | 出处 |
| --- | --- | --- |
| 平均绝对误差 MAE | 0.67 分（满分 10） | `eval/results.json` → `metrics.mae` |
| ±1 分以内 | 4/6（67%），完全一致 3/6 | `metrics.within1Rate` |
| 相关系数 | r = 0.96 | `metrics.pearson` |
| AI 单份耗时 | 3.2 秒 | `metrics.avgAiLatencyMs` |
| 人工单份耗时 | 待实测：在「人工计时」页批一遍，提交后报告自动补上 | 「人工计时」页 / `eval/human-timing.json` |

**迭代证据**（答辩加分项）：v1 宽松 Prompt + 弱模型 MAE 2.33 分且模型会编造评分依据 → v2 加服务端证据校验并换强模型降到 0.67 分。两版结果都存在 `eval/history/`。

## 4. 工程规范：代码能运行，Key 没写进代码

| 证据 | 验证方式 |
| --- | --- |
| `.env` 在 `.gitignore`，GitHub 仓库里没有 | 仓库页面搜 `.env` 应无结果 |
| 代码里只读 `process.env`，无硬编码 Key | `grep -r "sk-" server/ public/ scripts/` 无结果 |
| 换机器能跑：`npm install && cp .env.example .env && npm start` | `README.md` 快速开始 |
| `.env.example` 说明必填项，不暴露真实 Key | 仓库根目录 |

## 5. 团队分工：两人各有能指出来的成果

见 `docs/team.md`（分工表 + 每人对应的文件/成果/可现场讲解的部分）。建议 git 提交署名区分两人。
