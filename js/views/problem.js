// 做题页：题面/题解 + 编辑器 + 判题结果

import { judge, runCustom, isPythonReady, checkPythonSyntax } from '../judge.js';
import { compareAcmOutput } from '../compare.js';
import { createEditor } from '../editor.js';
import { registerDraftProvider } from '../assistant.js';
import { md } from '../md.js';
import { mountDirectory } from '../directory.js';
import { problems } from '../../problems/index.js';
import { articles } from '../../knowledge/index.js';
import {
  getDraft,
  clearDraft,
  stageDraft,
  flushDrafts,
  recordLearningAttempt,
  addMistake,
  removeMistake,
  isMistake,
  getLangPref,
  setLangPref,
  getEditorHeight,
  setEditorHeight as saveEditorHeight,
  getEditorFontSize,
  setEditorFontSize as saveEditorFontSize,
  DEFAULT_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  updateMistakeDetails,
  getAssistState,
  setAssistState,
  clearAssistState,
  getCustomInput,
  saveCustomInput,
  recordProblemReview,
  getLearningState,
} from '../store.js';

const DIFF_LABEL = { easy: '简单', medium: '中等', hard: '困难' };
const LANG_LABEL = { javascript: 'JavaScript', python: 'Python', cpp: 'C++' };

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderProblem(container, problem) {
  container.classList.add('app-wide'); // 做题页放宽布局
  const savedAssist = getAssistState(problem.id);
  const state = {
    mode: 'acm', // core | acm
    lang: getLangPref(), // javascript | python | cpp（跟随全局语言偏好，默认 Python）
    tab: 'desc', // desc | solution
    workTab: 'code', // code | result
    mobileTab: 'problem', // problem | code | result
    revealed: savedAssist.revealed,
    hintLevel: savedAssist.hintLevel,
    assisted: savedAssist.assisted,
    running: false,
  };
  let editor = null;
  let draftTimer = null;
  let syntaxTimer = null;
  let customInputTimer = null;
  let disposed = false;
  let runToken = 0;
  let customToken = 0;
  let syntaxToken = 0;
  const routeAtMount = location.hash;

  // 相关知识：按题目标签与文章标签的交集数排序，取匹配度最高的 1-2 篇
  const relatedArticles = articles
    .map((article) => ({
      article,
      score: problem.tags.filter((tag) => article.tags.includes(tag)).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title, 'zh'))
    .slice(0, 2)
    .map((entry) => entry.article);
  const articleByTag = new Map();
  for (const tag of problem.tags) {
    const match = articles.find((article) => article.tags.includes(tag));
    if (match) articleByTag.set(tag, match.slug);
  }

  container.innerHTML = `
    <div class="problem-storage-warning" id="storage-warning" role="alert" aria-live="assertive" hidden></div>
    <div class="phead">
      <a class="back" href="#/">← 返回</a>
      <h1>${problem.id}. ${escapeHtml(problem.title)}</h1>
      <div class="head-tags">
        <span class="diff ${problem.difficulty}" style="width:auto">${DIFF_LABEL[problem.difficulty]}</span>
        ${problem.tags
          .map((t) => `<a class="tag" href="${articleByTag.has(t) ? `#/knowledge/${articleByTag.get(t)}` : '#/knowledge'}" aria-label="查看与 ${escapeHtml(t)} 相关的知识">${escapeHtml(t)}</a>`)
          .join('')}
        <a class="lc-link" href="https://leetcode.cn/problems/${encodeURIComponent(problem.slug)}/" target="_blank" rel="noopener noreferrer" title="在力扣官网查看本题（新标签页打开）">力扣原题 ↗</a>
      </div>
      <div class="spacer"></div>
      <div class="seg" id="mode-seg" role="group" aria-label="代码模式">
        <button type="button" data-mode="core">核心代码</button>
        <button type="button" data-mode="acm" class="active">ACM 模式</button>
      </div>
      <div class="seg" id="lang-seg" role="group" aria-label="编程语言">
        <button type="button" data-lang="python">Python</button>
        <button type="button" data-lang="javascript">JavaScript</button>
        <button type="button" data-lang="cpp">C++</button>
      </div>
    </div>
    ${
      relatedArticles.length
        ? `<div class="related-knowledge" aria-label="相关知识文章">${relatedArticles
            .map((a) => `<a href="#/knowledge/${a.slug}">📖 先补基础：${escapeHtml(a.title)}</a>`)
            .join('')}</div>`
        : ''
    }
    <div id="mistake-info-slot"></div>
    <p class="mode-note">核心代码：只写函数本体，推荐新手；ACM 模式：自己处理输入输出，适合笔试练习</p>
    <div class="mobile-work-tabs" id="mobile-work-tabs" role="tablist" aria-label="做题区域">
      <button type="button" role="tab" id="mobile-tab-problem" data-mobile-tab="problem" aria-controls="problem-pane">题目</button>
      <button type="button" role="tab" id="mobile-tab-code" data-mobile-tab="code" aria-controls="code-pane">代码</button>
      <button type="button" role="tab" id="mobile-tab-result" data-mobile-tab="result" aria-controls="result-pane">结果</button>
    </div>
    <div class="pmain">
      <section class="panel problem-pane" id="problem-pane" role="tabpanel" aria-labelledby="mobile-tab-problem">
        <div class="panel-tabs" role="tablist" aria-label="题目内容">
          <button type="button" role="tab" id="content-tab-desc" aria-controls="panel-body" data-tab="desc" class="active">题目描述</button>
          <button type="button" role="tab" id="content-tab-solution" aria-controls="panel-body" data-tab="solution">题解</button>
        </div>
        <div class="panel-body" id="panel-body" role="tabpanel" aria-labelledby="content-tab-desc" tabindex="0"></div>
      </section>
      <div class="work">
        <div class="work-tabs" id="work-tabs" role="tablist" aria-label="代码与判题结果">
          <button type="button" role="tab" id="work-tab-code" data-work-tab="code" aria-controls="code-pane">代码</button>
          <button type="button" role="tab" id="work-tab-result" data-work-tab="result" aria-controls="result-pane">判题结果</button>
        </div>
        <div class="work-panels">
        <section class="code-pane" id="code-pane" role="tabpanel" aria-labelledby="mobile-tab-code">
          <div class="editor-wrap">
            <div class="editor-toolbar">
              <span class="hint" id="editor-hint"></span>
              <div class="editor-font-controls" role="group" aria-label="代码字号" title="Ctrl + 鼠标滚轮调整代码字号">
                <button type="button" class="btn" id="font-smaller" aria-label="缩小代码字体" title="缩小代码字体">A−</button>
                <button type="button" class="btn" id="font-reset" aria-label="恢复默认代码字号" title="恢复默认字号（13px）"></button>
                <button type="button" class="btn" id="font-larger" aria-label="放大代码字体" title="放大代码字体">A+</button>
              </div>
              <button type="button" class="btn" id="reset-btn">重置代码</button>
            </div>
            <div class="editor-host" id="editor-host" aria-label="代码编辑器"></div>
            <div class="editor-resize" id="editor-resize" role="separator" tabindex="0" aria-label="调整编辑器高度" aria-orientation="horizontal" aria-valuemin="200" title="拖拽或用方向键调整编辑器高度"></div>
          </div>
        </section>
        <section class="result-pane" id="result-pane" role="tabpanel" aria-labelledby="mobile-tab-result" tabindex="-1">
          <details class="custom-test" id="custom-test">
            <summary>自定义测试（只看运行结果，不计对错）</summary>
            <textarea id="custom-input" rows="3" spellcheck="false" aria-label="自定义测试输入"></textarea>
            <div id="custom-expected-wrap" hidden>
              <label for="custom-expected">期望输出（可选，填写后按 ACM 规则比对）</label>
              <textarea id="custom-expected" rows="3" spellcheck="false"></textarea>
              <label class="custom-ws-toggle"><input type="checkbox" id="custom-ws-toggle"> 可视化行尾空格（·）与换行（⏎）</label>
            </div>
            <div class="custom-actions">
              <button type="button" class="btn" id="custom-run">▶ 运行自定义测试</button>
              <button type="button" class="btn" id="custom-sample">填入样例输入</button>
              <span class="run-status" id="custom-status" role="status" aria-live="polite"></span>
            </div>
            <div class="custom-out" id="custom-out" role="status" aria-live="polite" tabindex="-1" hidden></div>
          </details>
          <div class="result-empty" id="result-empty" role="status">尚未运行代码。请切换到“代码”并执行判题。</div>
          <div class="results" id="results" aria-live="polite" hidden>
            <div class="results-head" id="results-head"></div>
            <div class="results-body" id="results-body"></div>
          </div>
          <div class="pnav" id="pnav"></div>
        </section>
        </div>
        <div class="actions">
          <button type="button" class="btn primary" id="run-btn">▶ 执行并判题</button>
          <button type="button" class="btn" id="mistake-btn"></button>
          <span class="kbd-hint"><kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> 判题 · <kbd>Alt</kbd>+<kbd>←/→</kbd> 上/下一题</span>
          <span class="run-status" id="run-status" role="status" aria-live="polite"></span>
        </div>
      </div>
    </div>
  `;

  const $ = (sel) => container.querySelector(sel);
  const panelBody = $('#panel-body');
  const runBtn = $('#run-btn');
  const runStatus = $('#run-status');
  const resultsEl = $('#results');
  const resultsHead = $('#results-head');
  const resultsBody = $('#results-body');
  const resultEmpty = $('#result-empty');
  const storageWarning = $('#storage-warning');

  function validRoute(token, currentToken) {
    return !disposed && location.hash === routeAtMount && token === currentToken;
  }

  function reportStorage(result, action = '保存') {
    if (result && result.ok) return true;
    const detail = result?.error?.message || '浏览器存储不可用';
    storageWarning.hidden = false;
    storageWarning.textContent = `${action}失败：${detail}。请复制代码到安全位置后再离开页面。`;
    return false;
  }

  // ---------- 代码与草稿 ----------

  function templateCode() {
    return problem.templates[state.mode][state.lang];
  }

  function initialCode() {
    const draft = getDraft(problem.id, state.mode, state.lang);
    return draft === null ? templateCode() : draft;
  }

  function stageCurrentDraft(code = editor?.getValue()) {
    if (code === undefined) return true;
    return reportStorage(stageDraft(problem.id, state.mode, state.lang, code), '暂存草稿');
  }

  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    stageCurrentDraft();
    return reportStorage(flushDrafts(), '保存草稿');
  }

  // 判题/自定义运行开始前调用：取消待触发的语法检查，并使已发出的检查失效。
  // 语法检查与判题共用串行 Pyodide Worker，排队中的检查可能在判题后才返回，
  // 其回调不得再清除判题刚设置的错误 marker。
  function cancelSyntaxCheck() {
    syntaxToken += 1;
    clearTimeout(syntaxTimer);
    syntaxTimer = null;
  }

  function invalidateAsync({ clearResults = true } = {}) {
    runToken += 1;
    customToken += 1;
    cancelSyntaxCheck();
    state.running = false;
    runBtn.disabled = false;
    $('#custom-run').disabled = false;
    runStatus.textContent = '';
    $('#custom-status').textContent = '';
    $('#custom-out').hidden = true;
    if (clearResults) {
      resultsEl.hidden = true;
      resultEmpty.hidden = false;
    }
    editor?.clearError();
  }

  function updateHint() {
    const hint = $('#editor-hint');
    if (state.mode === 'core') {
      hint.textContent = problem.design
        ? `实现类 ${problem.className}，判题器会按操作序列调用并比对每步返回值`
        : `实现函数 ${problem.functionName}，判题器会自动调用并比对返回值`;
    } else if (state.lang === 'javascript') {
      hint.textContent = '从 input 变量读取全部输入（字符串），用 console.log 输出答案';
    } else if (state.lang === 'cpp') {
      hint.textContent = '用 cin 读取输入，用 cout 输出答案（C++ 判题需联网，走远程编译）';
    } else {
      hint.textContent = '用 input() 或 sys.stdin 读取输入，并用 print 输出答案';
    }
    if (state.lang === 'python' && !isPythonReady()) {
      hint.textContent += ' · 运行一次后开启实时语法检查';
    }
  }

  // ---------- 自定义测试 ----------

  function syncCustomTest() {
    const box = $('#custom-test');
    const ta = $('#custom-input');
    if (problem.design && state.mode === 'core') {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    ta.value = getCustomInput(problem.id, state.mode);
    $('#custom-expected-wrap').hidden = state.mode !== 'acm';
    ta.placeholder =
      state.mode === 'core'
        ? `函数参数（JSON 数组），如 ${problem.argSpec ? '[[1,2,3,4,5]]' : '[[2,7,11,15], 9]'}`
        : '标准输入内容（原样作为 stdin）';
  }

  function scheduleCustomInputSave() {
    clearTimeout(customInputTimer);
    customInputTimer = setTimeout(() => {
      reportStorage(saveCustomInput(problem.id, state.mode, $('#custom-input').value), '保存自定义输入');
    }, 400);
  }

  function visualizeWhitespace(text) {
    return escapeHtml(text)
      .replace(/ /g, '<span class="whitespace">·</span>')
      .replace(/\n/g, '<span class="whitespace">⏎</span>\n');
  }

  // 空白可视化下的 diff：空行用占位符高亮，避免看不见的差异
  function diffPairVisual(expected, got) {
    const d = diffPair(expected, got);
    const mark = (html) =>
      html
        .replace(/ /g, '<span class="whitespace">·</span>')
        .replace(/\n/g, '<span class="whitespace">⏎</span>\n')
        .replace(/(^|\n)(?=\n|$)/g, '$1<span class="diff-blank">（空行）</span>');
    return { expectedHtml: mark(d.expectedHtml), gotHtml: mark(d.gotHtml) };
  }

  function renderCustomOutput(res, snapshot, expected) {
    const out = $('#custom-out');
    const wsOn = $('#custom-ws-toggle').checked;
    const fmt = (text) => (wsOn ? visualizeWhitespace(text) : escapeHtml(text));
    let html = '';
    if (snapshot.mode === 'acm' && expected.trim()) {
      const pass = compareAcmOutput(expected, res.output ?? '', problem.numericTolerance ?? null);
      html += `<div class="custom-verdict ${pass ? 'all-pass' : 'has-fail'}">${pass ? '✓ 与期望输出一致' : '✗ 与期望输出不一致'}</div>`;
      if (!pass) {
        const d = wsOn ? diffPairVisual(expected, res.output ?? '') : diffPair(expected, res.output ?? '');
        html += `<div class="custom-diff"><div><strong>期望</strong></div>${d.expectedHtml}<div><strong>你的输出</strong></div>${d.gotHtml}</div>`;
      }
      html += '<div class="mode-note">ACM 比对规则：忽略行尾空格，空行有意义，数值默认严格（除非题目配置容差）。</div>';
    }
    if (res.error) {
      const partial = res.output ? fmt(res.output) + '\n' : '';
      html += `${partial}<span class="run-err">${escapeHtml(res.error)}</span>`;
    } else if (!(snapshot.mode === 'acm' && expected.trim())) {
      html += snapshot.mode === 'core' ? `返回：${fmt(res.output ?? '')}` : fmt(res.output ?? '');
    }
    if (res.stdout && snapshot.mode === 'core') {
      html += `<div class="stdout-label">控制台输出</div><pre class="stdout">${fmt(res.stdout)}</pre>`;
    }
    out.innerHTML = html;
  }

  async function runCustomTest() {
    if ($('#custom-run').disabled || !editor) return;
    cancelSyntaxCheck();
    flushDraft();
    reportStorage(saveCustomInput(problem.id, state.mode, $('#custom-input').value), '保存自定义输入');
    const out = $('#custom-out');
    const status = $('#custom-status');
    const input = $('#custom-input').value;
    const expected = state.mode === 'acm' ? $('#custom-expected').value : '';
    const snapshot = Object.freeze({ code: editor.getValue(), problem, mode: state.mode, lang: state.lang });
    if (snapshot.mode === 'core' && !input.trim()) {
      out.hidden = false;
      out.innerHTML = '<span class="run-err">请填写函数参数（JSON 数组格式）</span>';
      out.focus();
      return;
    }
    const token = ++customToken;
    $('#custom-run').disabled = true;
    status.textContent = '运行中…';
    out.hidden = true;
    try {
      const res = await runCustom({
        ...snapshot,
        input,
        onStatus: (stage) => {
          if (!validRoute(token, customToken)) return;
          status.textContent = stage === 'loading' ? '正在加载 Python 环境…' : stage === 'compiling' ? '正在远程编译运行 C++…' : '运行中…';
        },
      });
      if (!validRoute(token, customToken)) return;
      out.hidden = false;
      renderCustomOutput(res, snapshot, expected);
      out.focus();
    } catch (err) {
      if (!validRoute(token, customToken)) return;
      out.hidden = false;
      out.innerHTML = `<span class="run-err">${escapeHtml(String(err))}</span>`;
      out.focus();
    } finally {
      if (validRoute(token, customToken)) {
        $('#custom-run').disabled = false;
        status.textContent = '';
      }
    }
  }

  $('#custom-run').addEventListener('click', runCustomTest);
  $('#custom-input').addEventListener('input', scheduleCustomInputSave);
  $('#custom-ws-toggle').addEventListener('change', () => {
    const out = $('#custom-out');
    if (!out.hidden) $('#custom-run').click();
  });
  $('#custom-sample').addEventListener('click', () => {
    const ta = $('#custom-input');
    if (state.mode === 'core') {
      const sample = problem.tests && problem.tests[0];
      ta.value = sample ? JSON.stringify(sample.args) : '';
    } else {
      const sample = problem.acmTests && problem.acmTests[0];
      ta.value = sample ? sample.input : '';
      const expectedTa = $('#custom-expected');
      if (sample && !expectedTa.value) expectedTa.value = sample.output;
    }
    scheduleCustomInputSave();
  });

  // ---------- 左侧：题目描述 / 提示 / 题解 ----------

  function solutionHtml() {
    const code = problem.solutions[state.mode][state.lang];
    const modeLabel = state.mode === 'core' ? '核心代码' : 'ACM 模式';
    return `
      <div class="solution-block">
        <h3>思路</h3>
        ${md(problem.idea)}
        <h3>参考代码（${modeLabel} · ${LANG_LABEL[state.lang]}）</h3>
        <div class="code-with-copy">
          <button type="button" class="copy-btn" data-copy-code aria-label="复制参考代码">复制</button>
          <pre><code>${escapeHtml(code)}</code></pre>
        </div>
        <h3>代码解析</h3>
        ${md(problem.explanation)}
      </div>`;
  }

  function persistAssist() {
    reportStorage(
      setAssistState(problem.id, {
        assisted: state.assisted,
        hintLevel: state.hintLevel,
        revealed: state.revealed,
      }),
      '保存提示状态'
    );
  }

  function assistanceHtml() {
    const hints = Array.isArray(problem.hints) ? problem.hints.slice(0, 4) : [];
    const shown = hints.slice(0, state.hintLevel);
    return `
      <section class="progressive-hints" id="progressive-hints" aria-labelledby="hints-title">
        <h3 id="hints-title">逐级提示</h3>
        ${shown.map((hint, index) => `<div class="hint-level"><strong>提示 ${index + 1}</strong>${md(hint)}</div>`).join('')}
        ${state.hintLevel < hints.length ? `<button type="button" class="btn" id="next-hint-btn">展开提示 ${state.hintLevel + 1}</button>` : ''}
        ${!hints.length ? '<p>本题暂无分层提示。</p>' : ''}
        ${state.assisted ? '<button type="button" class="btn independent-redo" id="independent-redo-btn">独立重做</button>' : ''}
      </section>`;
  }

  function bindAssistanceActions() {
    $('#next-hint-btn')?.addEventListener('click', () => {
      state.hintLevel += 1;
      state.assisted = true;
      persistAssist();
      renderPanel();
      $('#next-hint-btn')?.focus();
    });
    $('#independent-redo-btn')?.addEventListener('click', () => {
      state.assisted = false;
      state.hintLevel = 0;
      state.revealed = false;
      state.tab = 'desc';
      reportStorage(clearAssistState(problem.id), '清除提示状态');
      renderPanel();
      panelBody.focus();
    });
  }

  function renderPanel() {
    container.querySelectorAll('.panel-tabs button').forEach((button) => {
      const selected = button.dataset.tab === state.tab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    panelBody.setAttribute('aria-labelledby', state.tab === 'desc' ? 'content-tab-desc' : 'content-tab-solution');
    if (state.tab === 'desc') {
      const hints = Array.isArray(problem.hints) ? problem.hints.slice(0, 4) : [];
      const anchor = hints.length
        ? `<a class="hint-anchor" href="#progressive-hints" id="hint-anchor">没思路？本题有 ${hints.length} 条逐级提示 →</a>`
        : '';
      panelBody.innerHTML = `<div class="desc">${anchor}${md(problem.description)}</div>${assistanceHtml()}`;
      // 渲染层映射：题面中“提示”小节实际展示的是数据范围，避免与逐级提示混淆
      panelBody.querySelectorAll('.desc h3').forEach((h) => {
        if (h.textContent.trim() === '提示') h.textContent = '数据范围';
      });
      $('#hint-anchor')?.addEventListener('click', (event) => {
        event.preventDefault();
        $('#progressive-hints')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      bindAssistanceActions();
      return;
    }
    if (!state.revealed) {
      panelBody.innerHTML = `
        <div class="reveal-box">
          <p>先自己想一想，实在没思路再看题解。</p>
          <p><button type="button" class="btn" id="reveal-btn">显示完整题解（计为借助）</button></p>
          ${state.assisted ? '<button type="button" class="btn independent-redo" id="independent-redo-btn">独立重做</button>' : ''}
        </div>`;
      $('#reveal-btn').addEventListener('click', () => {
        state.revealed = true;
        state.assisted = true;
        persistAssist();
        renderPanel();
        panelBody.focus();
      });
      bindAssistanceActions();
      return;
    }
    panelBody.innerHTML = `${solutionHtml()}${assistanceHtml()}`;
    bindAssistanceActions();
    const copyBtn = panelBody.querySelector('[data-copy-code]');
    copyBtn?.addEventListener('click', async () => {
      const code = panelBody.querySelector('.code-with-copy code').textContent;
      try {
        await navigator.clipboard.writeText(code);
        copyBtn.textContent = '已复制 ✓';
      } catch {
        copyBtn.textContent = '复制失败';
      }
      setTimeout(() => {
        if (!disposed) copyBtn.textContent = '复制';
      }, 1500);
    });
  }

  // 左侧跳转目录：全部题目，排版跟随题库列表页视图偏好
  const directory = mountDirectory({ kind: 'problems', currentId: problem.id });

  // ---------- 判题结果 ----------

  // 失败用例的「期望 vs 你的输出」差异高亮：
  // 按行配对，公共前缀/后缀之外的中段分别标绿（期望）标红（你的输出）
  function diffPair(expected, got) {
    const eLines = String(expected).split('\n');
    const gLines = String(got).split('\n');
    const n = Math.max(eLines.length, gLines.length);
    const eOut = [];
    const gOut = [];
    const wrap = (t, cls) => (t === '' ? '' : `<span class="${cls}">${escapeHtml(t)}</span>`);
    for (let i = 0; i < n; i++) {
      const e = eLines[i];
      const g = gLines[i];
      if (e === undefined) {
        gOut.push(wrap(g, 'diff-bad'));
        eOut.push('');
        continue;
      }
      if (g === undefined) {
        eOut.push(wrap(e, 'diff-ok'));
        gOut.push('');
        continue;
      }
      if (e === g) {
        eOut.push(escapeHtml(e));
        gOut.push(escapeHtml(g));
        continue;
      }
      let p = 0;
      while (p < e.length && p < g.length && e[p] === g[p]) p++;
      let s = 0;
      while (s < e.length - p && s < g.length - p && e[e.length - 1 - s] === g[g.length - 1 - s]) s++;
      eOut.push(escapeHtml(e.slice(0, p)) + wrap(e.slice(p, e.length - s), 'diff-ok') + escapeHtml(e.slice(e.length - s)));
      gOut.push(escapeHtml(g.slice(0, p)) + wrap(g.slice(p, g.length - s), 'diff-bad') + escapeHtml(g.slice(g.length - s)));
    }
    return { expectedHtml: eOut.join('\n'), gotHtml: gOut.join('\n') };
  }

  const RESULT_TRUNC = 400;

  function resultValue(label, value, html) {
    const text = String(value ?? '');
    const rendered = html ?? escapeHtml(text);
    if (text.length <= RESULT_TRUNC) {
      return `<div class="kv"><span class="k">${label}</span><pre>${rendered}</pre><button type="button" class="result-copy" data-copy-result="${escapeHtml(text)}" aria-label="复制${label}">复制</button></div>`;
    }
    return `<div class="kv result-long"><span class="k">${label}</span>
      <details><summary>${escapeHtml(text.slice(0, RESULT_TRUNC))}\n…（共 ${text.length} 字符，展开全文）</summary><pre>${escapeHtml(text)}</pre></details>
      <button type="button" class="result-copy" data-copy-result="${escapeHtml(text)}" aria-label="复制${label}全文">复制全文</button>
    </div>`;
  }

  function failureReviewHtml() {
    const reasons = ['思路不清', '边界遗漏', '复杂度不符', '语法或 API', '输出格式', '其他'];
    return `<section class="mistake-review" aria-labelledby="mistake-review-title">
      <h3 id="mistake-review-title">记录失败原因</h3>
      <div class="mistake-reasons" role="group" aria-label="失败原因快捷选择">
        ${reasons.map((reason) => `<button type="button" class="btn mistake-reason" data-reason="${reason}" aria-pressed="false">${reason}</button>`).join('')}
      </div>
      <label for="mistake-note">复盘笔记</label>
      <textarea id="mistake-note" rows="3" placeholder="记录错误现象、修正思路或边界条件"></textarea>
      <button type="button" class="btn" id="save-mistake-details">保存复盘</button>
      <span id="mistake-save-status" role="status" aria-live="polite"></span>
    </section>`;
  }

  // ---------- 复习闭环 ----------

  function readQueue(key) {
    try {
      const raw = sessionStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : null;
      return Array.isArray(list) ? list.map(Number).filter(Number.isFinite) : null;
    } catch {
      return null;
    }
  }

  function reviewQueueNext() {
    const queue = readQueue('hot100_review_queue');
    if (!queue) return null;
    const idx = queue.indexOf(problem.id);
    if (idx === -1) return null;
    return { queue, idx, next: queue[idx + 1] };
  }

  function reviewProgressText(review) {
    if (!review) return '';
    if (review.stage >= 3 || (review.dueAt === 0 && review.lastReviewedAt > 0)) return '三轮复习已完成';
    return `复习进度 ${review.stage}/3`;
  }

  function reviewBannerHtml(verdict, assisted) {
    const learning = getLearningState().problems[String(problem.id)];
    const review = learning?.review;
    const inProgress = review && !(review.stage >= 3 || (review.dueAt === 0 && review.lastReviewedAt > 0));
    if (!inProgress) return '';
    if (verdict.status === 'pass' && !assisted) {
      return `<div class="review-banner" role="group" aria-label="复习确认">
        <span>记为复习通过？</span>
        <button type="button" class="btn small" id="review-pass-btn">确认</button>
        <button type="button" class="btn small" id="review-ignore-btn">忽略</button>
        <span class="review-status" role="status" aria-live="polite"></span>
      </div>`;
    }
    if (verdict.status === 'pass' && assisted) {
      return `<div class="review-banner"><span>本次计为借助，复习未推进。</span></div>`;
    }
    if (verdict.status === 'fail') {
      return `<div class="review-banner" role="group" aria-label="复习确认">
        <span>本次未通过。</span>
        <button type="button" class="btn small" id="review-fail-btn">记为复习未通过</button>
        <span class="review-status" role="status" aria-live="polite"></span>
      </div>`;
    }
    return '';
  }

  function bindReviewBanner() {
    const status = resultsBody.querySelector('.review-status');
    const afterMark = () => {
      const learning = getLearningState().problems[String(problem.id)];
      const text = reviewProgressText(learning?.review);
      const q = reviewQueueNext();
      if (q && q.next !== undefined) {
        status.innerHTML = `${escapeHtml(text)} · <a class="review-next" href="#/problem/${q.next}">继续下一道错题 →</a>`;
      } else if (q) {
        try { sessionStorage.removeItem('hot100_review_queue'); } catch { /* 忽略 */ }
        status.textContent = `${text} · 复习队列已完成`;
      } else {
        status.textContent = text;
      }
      renderMistakeInfo();
    };
    $('#review-pass-btn')?.addEventListener('click', () => {
      const result = recordProblemReview(problem.id, true);
      if (!reportStorage(result, '记录复习')) return;
      $('#review-pass-btn').disabled = true;
      $('#review-ignore-btn').disabled = true;
      afterMark();
    });
    $('#review-ignore-btn')?.addEventListener('click', () => {
      $('#review-pass-btn').closest('.review-banner').remove();
    });
    $('#review-fail-btn')?.addEventListener('click', () => {
      const result = recordProblemReview(problem.id, false);
      if (!reportStorage(result, '记录复习')) return;
      $('#review-fail-btn').disabled = true;
      afterMark();
    });
  }

  function renderMistakeInfo() {
    const slot = $('#mistake-info-slot');
    if (!isMistake(problem.id)) {
      slot.innerHTML = '';
      return;
    }
    const learning = getLearningState().problems[String(problem.id)];
    const mistake = learning?.mistake;
    const review = learning?.review;
    const reason = mistake?.reason ? `<span class="error-badge">${escapeHtml(mistake.reason)}</span>` : '';
    const note = mistake?.note ? escapeHtml(mistake.note.length > 60 ? mistake.note.slice(0, 60) + '…' : mistake.note) : '';
    const progress = review ? reviewProgressText(review) : '';
    slot.innerHTML = `
      <details class="mistake-info">
        <summary>错题信息 ${reason} ${progress ? `· ${escapeHtml(progress)}` : ''}</summary>
        ${note ? `<p>${note}</p>` : '<p>暂无复盘笔记。</p>'}
      </details>`;
  }

  function bindResultActions(verdict) {
    resultsBody.querySelectorAll('[data-copy-result]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copyResult);
          button.textContent = '已复制 ✓';
        } catch {
          button.textContent = '复制失败';
        }
      });
    });
    bindReviewBanner();
    if (verdict.status !== 'fail') return;
    let reason = '';
    resultsBody.querySelectorAll('.mistake-reason').forEach((button) => {
      button.addEventListener('click', () => {
        reason = button.dataset.reason;
        resultsBody.querySelectorAll('.mistake-reason').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      });
    });
    $('#save-mistake-details')?.addEventListener('click', () => {
      const status = $('#mistake-save-status');
      const result = updateMistakeDetails(problem.id, { reason, note: $('#mistake-note').value });
      if (reportStorage(result, '保存复盘')) {
        status.textContent = '已保存';
        renderMistakeInfo();
      }
    });
  }

  function focusResults() {
    showMobileTab('result');
    const pane = $('#result-pane');
    pane.focus({ preventScroll: true });
    resultsHead.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderVerdict(verdict, runLang, assisted) {
    resultEmpty.hidden = true;
    resultsEl.hidden = false;
    if (verdict.status === 'compileError') {
      resultsHead.innerHTML =
        '<span class="has-fail">✗ 编译 / 运行错误' + (verdict.errorLine ? `（第 ${verdict.errorLine} 行）` : '') + '</span>';
      resultsBody.innerHTML =
        resultValue('错误', verdict.error) +
        (verdict.rawError ? `<details class="raw-error-wrap"><summary>原始错误堆栈</summary><pre class="raw-error">${escapeHtml(verdict.rawError)}</pre></details>` : '');
      if (editor && verdict.errorLine) editor.setError(verdict.errorLine, verdict.error);
      bindResultActions(verdict);
      focusResults();
      return;
    }
    editor?.clearError();
    if (verdict.status === 'timeout') {
      const message = verdict.loading
        ? 'Python 运行环境加载超时，请检查网络（需访问 CDN）后重试。'
        : runLang === 'python'
          ? '代码执行超时，可能存在死循环。Python 运行环境已自动重置。'
          : '代码执行超时，可能存在死循环。';
      resultsHead.innerHTML = '<span class="has-fail">✗ 执行超时</span>';
      resultsBody.innerHTML = resultValue('错误', message);
      bindResultActions(verdict);
      focusResults();
      return;
    }
    const passed = verdict.cases.filter((c) => c.pass).length;
    const total = verdict.cases.length;
    const nextLink = verdict.status === 'pass' && nextProblem
      ? ` <a class="btn primary result-next" href="#/problem/${nextProblem.id}">下一题 →</a>`
      : '';
    resultsHead.innerHTML =
      (verdict.status === 'pass'
        ? `<span class="all-pass">✓ 全部通过（${total}/${total}）</span>`
        : `<span class="has-fail">✗ 通过 ${passed}/${total} 个用例</span>`) + nextLink;

    const caseCard = (c) => {
      let expectedHtml;
      let gotHtml;
      if (!c.pass && c.got !== undefined && c.expected !== undefined && String(c.expected).length <= RESULT_TRUNC && String(c.got).length <= RESULT_TRUNC) {
        const diff = diffPair(c.expected, c.got);
        expectedHtml = diff.expectedHtml;
        gotHtml = diff.gotHtml;
      }
      const errorBadge = c.errorType ? `<span class="error-badge">${escapeHtml(c.errorType)}</span>` : '';
      const rawError = c.rawError
        ? `<details class="raw-error-wrap"><summary>原始错误堆栈</summary><pre class="raw-error">${escapeHtml(c.rawError)}</pre></details>`
        : '';
      const stdout = c.stdout ? `<div class="kv"><span class="k">控制台输出</span><pre class="stdout">${escapeHtml(c.stdout)}</pre></div>` : '';
      return `<div class="case ${c.pass ? 'pass' : 'fail'}">
        <div class="case-title">${c.pass ? '<span class="ok">✓</span>' : '<span class="no">✗</span>'} 用例 ${c.index + 1} ${errorBadge}</div>
        ${resultValue('输入', c.input)}
        ${resultValue('期望', c.expected, expectedHtml)}
        ${c.got !== undefined ? resultValue('你的输出', c.got, gotHtml) : ''}
        ${stdout}
        ${c.error ? resultValue('错误', c.error) : ''}
        ${rawError}
      </div>`;
    };

    const passedCases = verdict.cases.filter((c) => c.pass);
    const failedCases = verdict.cases.filter((c) => !c.pass);
    const passedSummary = passedCases.length
      ? `<details class="passed-cases"><summary>✓ ${passedCases.length} 个通过（用例 ${passedCases.map((c) => c.index + 1).join(', ')}，点击展开）</summary>${passedCases.map(caseCard).join('')}</details>`
      : '';
    resultsBody.innerHTML =
      reviewBannerHtml(verdict, assisted) +
      passedSummary +
      failedCases.map(caseCard).join('') +
      (verdict.status === 'fail' ? failureReviewHtml() : '');
    if (verdict.status === 'fail' && verdict.errorLine && editor) {
      const failing = verdict.cases.find((c) => !c.pass && c.errorLine);
      editor.setError(verdict.errorLine, failing ? failing.error : '此行出错');
    }
    bindResultActions(verdict);
    focusResults();
  }

  async function run() {
    if (state.running || !editor) return;
    cancelSyntaxCheck();
    flushDraft();
    const snapshot = Object.freeze({
      code: editor.getValue(),
      problem,
      mode: state.mode,
      lang: state.lang,
      assisted: state.assisted,
    });
    const token = ++runToken;
    state.running = true;
    runBtn.disabled = true;
    runStatus.textContent = '运行中…';
    try {
      const verdict = await judge({
        code: snapshot.code,
        problem: snapshot.problem,
        mode: snapshot.mode,
        lang: snapshot.lang,
        onStatus: (stage) => {
          if (!validRoute(token, runToken)) return;
          runStatus.textContent = stage === 'loading' ? '正在加载 Python 环境（首次约需几秒）…' : stage === 'compiling' ? '正在远程编译运行 C++（需联网）…' : '运行中…';
        },
      });
      if (!validRoute(token, runToken)) return;
      renderVerdict(verdict, snapshot.lang, snapshot.assisted);
      const outcome = verdict.status === 'pass' ? 'pass' : verdict.status === 'fail' ? 'fail' : 'error';
      reportStorage(recordLearningAttempt(problem.id, snapshot.mode, outcome, { assisted: snapshot.assisted }), '保存学习记录');
      updateMistakeBtn();
      renderMistakeInfo();
    } catch (err) {
      if (!validRoute(token, runToken)) return;
      renderVerdict({ status: 'compileError', error: String(err), cases: [] }, snapshot.lang, snapshot.assisted);
    } finally {
      if (validRoute(token, runToken)) {
        state.running = false;
        runBtn.disabled = false;
        runStatus.textContent = '';
      }
    }
  }

  // ---------- 模式 / 语言切换 ----------

  function switchTarget() {
    invalidateAsync();
    container.querySelectorAll('#mode-seg button').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
    container.querySelectorAll('#lang-seg button').forEach((button) => button.classList.toggle('active', button.dataset.lang === state.lang));
    if (editor) {
      editor.setLanguage(state.lang);
      editor.setValue(initialCode());
    }
    updateHint();
    syncCustomTest();
    renderPanel();
  }

  const mobileMedia = window.matchMedia('(max-width: 900px)');

  function showMobileTab(tab, { focus = false } = {}) {
    state.mobileTab = tab;
    if (tab !== 'problem') state.workTab = tab;
    const mobile = mobileMedia.matches;
    $('#mobile-work-tabs').hidden = !mobile;
    $('#work-tabs').hidden = mobile;
    $('.work').hidden = mobile && tab === 'problem';
    container.querySelectorAll('[data-mobile-tab]').forEach((button) => {
      const selected = button.dataset.mobileTab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle('active', selected);
      if (focus && selected && mobile) button.focus();
    });
    container.querySelectorAll('[data-work-tab]').forEach((button) => {
      const selected = button.dataset.workTab === state.workTab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle('active', selected);
      if (focus && selected && !mobile) button.focus();
    });
    for (const name of ['problem', 'code', 'result']) {
      const pane = $(`#${name}-pane`);
      const hidden = mobile ? name !== tab : name !== 'problem' && name !== state.workTab;
      pane.hidden = hidden;
      pane.setAttribute('aria-hidden', String(hidden));
      if (name !== 'problem') pane.setAttribute('aria-labelledby', `${mobile ? 'mobile' : 'work'}-tab-${name}`);
    }
    if (mobile ? tab === 'code' : state.workTab === 'code') requestAnimationFrame(() => editor?.layout?.());
  }

  function adjacentTab(buttons, current, direction) {
    const index = buttons.indexOf(current);
    return buttons[(index + direction + buttons.length) % buttons.length];
  }

  function moveTabFocus(buttons, current, direction) {
    adjacentTab(buttons, current, direction).focus();
  }

  $('#mobile-work-tabs').addEventListener('click', (event) => {
    const tab = event.target.dataset.mobileTab;
    if (tab) showMobileTab(tab);
  });
  $('#mobile-work-tabs').addEventListener('keydown', (event) => {
    const buttons = [...container.querySelectorAll('[data-mobile-tab]')];
    let next;
    if (event.key === 'ArrowRight') next = adjacentTab(buttons, event.target, 1);
    else if (event.key === 'ArrowLeft') next = adjacentTab(buttons, event.target, -1);
    else return;
    event.preventDefault();
    showMobileTab(next.dataset.mobileTab, { focus: true });
  });
  $('#work-tabs').addEventListener('click', (event) => {
    const tab = event.target.dataset.workTab;
    if (tab) showMobileTab(tab);
  });
  $('#work-tabs').addEventListener('keydown', (event) => {
    const buttons = [...container.querySelectorAll('[data-work-tab]')];
    let next;
    if (event.key === 'ArrowRight') next = adjacentTab(buttons, event.target, 1);
    else if (event.key === 'ArrowLeft') next = adjacentTab(buttons, event.target, -1);
    else if (event.key === 'Home') next = buttons[0];
    else if (event.key === 'End') next = buttons[buttons.length - 1];
    else return;
    event.preventDefault();
    showMobileTab(next.dataset.workTab, { focus: true });
  });
  const onMobileMediaChange = () => showMobileTab(state.mobileTab);
  mobileMedia.addEventListener('change', onMobileMediaChange);

  // ---------- 事件绑定 ----------

  $('#mode-seg').addEventListener('click', (event) => {
    const mode = event.target.dataset.mode;
    if (!mode || mode === state.mode) return;
    flushDraft();
    state.mode = mode;
    switchTarget();
  });
  $('#lang-seg').addEventListener('click', (event) => {
    const lang = event.target.dataset.lang;
    if (!lang || lang === state.lang) return;
    flushDraft();
    state.lang = lang;
    reportStorage(setLangPref(lang), '保存语言偏好');
    switchTarget();
  });
  container.querySelectorAll('.panel-tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      renderPanel();
    });
  });
  $('.panel-tabs').addEventListener('keydown', (event) => {
    const buttons = [...container.querySelectorAll('.panel-tabs button')];
    if (event.key === 'ArrowRight') moveTabFocus(buttons, event.target, 1);
    else if (event.key === 'ArrowLeft') moveTabFocus(buttons, event.target, -1);
    else return;
    event.preventDefault();
  });
  $('#reset-btn').addEventListener('click', () => {
    if (!editor || !confirm('重置为模板代码？当前代码草稿将被清除。')) return;
    invalidateAsync();
    reportStorage(clearDraft(problem.id, state.mode, state.lang), '清除草稿');
    editor.setValue(templateCode());
    stageCurrentDraft(templateCode());
    flushDraft();
  });
  runBtn.addEventListener('click', run);

  // ---------- 错题集 ----------

  function updateMistakeBtn() {
    const saved = isMistake(problem.id);
    $('#mistake-btn').textContent = saved ? '✓ 已在错题集（点击移除）' : '☆ 加入错题集';
    $('#mistake-btn').setAttribute('aria-pressed', String(saved));
  }
  $('#mistake-btn').addEventListener('click', () => {
    const result = isMistake(problem.id) ? removeMistake(problem.id) : addMistake(problem.id);
    reportStorage(result, '更新错题集');
    updateMistakeBtn();
  });

  // ---------- 初始化 ----------

  renderPanel();
  updateHint();
  syncCustomTest();
  updateMistakeBtn();
  renderMistakeInfo();
  showMobileTab('problem');
  container.querySelectorAll('#mode-seg button').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
  container.querySelectorAll('#lang-seg button').forEach((button) => button.classList.toggle('active', button.dataset.lang === state.lang));

  // 上一题 / 下一题：优先按题库筛选队列（sessionStorage hot100_list_queue），无队列回退题号顺序
  const listQueue = readQueue('hot100_list_queue');
  let prev = null;
  let next = null;
  if (listQueue && listQueue.includes(problem.id)) {
    const qi = listQueue.indexOf(problem.id);
    prev = problems.find((item) => item.id === listQueue[qi - 1]) || null;
    next = problems.find((item) => item.id === listQueue[qi + 1]) || null;
  } else {
    const idx = problems.findIndex((item) => item.id === problem.id);
    prev = problems[idx - 1] || null;
    next = problems[idx + 1] || null;
  }
  const nextProblem = next;
  $('#pnav').innerHTML = `
    ${prev ? `<a class="btn" href="#/problem/${prev.id}" aria-label="上一题：${escapeHtml(prev.title)}">← ${prev.id}. ${escapeHtml(prev.title)}</a>` : '<span></span>'}
    ${next ? `<a class="btn" href="#/problem/${next.id}" aria-label="下一题：${escapeHtml(next.title)}">${next.id}. ${escapeHtml(next.title)} →</a>` : '<span></span>'}
  `;

  let editorFontSize = getEditorFontSize();
  function updateFontControls() {
    $('#font-reset').textContent = `${editorFontSize}px`;
    $('#font-reset').setAttribute('aria-label', `当前代码字号 ${editorFontSize}px，点击恢复默认字号`);
    $('#font-smaller').disabled = editorFontSize <= MIN_EDITOR_FONT_SIZE;
    $('#font-larger').disabled = editorFontSize >= MAX_EDITOR_FONT_SIZE;
  }
  function changeFontSize(size) {
    editorFontSize = Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, size));
    editor?.setFontSize(editorFontSize);
    updateFontControls();
    reportStorage(saveEditorFontSize(editorFontSize), '保存代码字号');
  }
  $('#font-smaller').onclick = () => changeFontSize(editorFontSize - 1);
  $('#font-larger').onclick = () => changeFontSize(editorFontSize + 1);
  $('#font-reset').onclick = () => changeFontSize(DEFAULT_EDITOR_FONT_SIZE);
  updateFontControls();

  // 编辑器高度：恢复上次高度，Pointer Events 拖拽并支持键盘调整。
  const editorHost = $('#editor-host');
  const onEditorWheel = (event) => {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    changeFontSize(editorFontSize + (event.deltaY < 0 ? 1 : -1));
  };
  editorHost.addEventListener('wheel', onEditorWheel, { capture: true, passive: false });
  const resizeEl = $('#editor-resize');
  const minEditorHeight = 200;
  const maxEditorHeight = () => Math.min(1200, Math.max(minEditorHeight, Math.round(window.innerHeight * 0.8)));
  let resizeStart = null;

  function setEditorHeight(height) {
    const nextHeight = Math.min(Math.max(Math.round(height), minEditorHeight), maxEditorHeight());
    editorHost.style.height = `${nextHeight}px`;
    resizeEl.setAttribute('aria-valuenow', String(nextHeight));
    resizeEl.setAttribute('aria-valuemax', String(maxEditorHeight()));
  }

  function persistEditorHeight() {
    reportStorage(saveEditorHeight(editorHost.offsetHeight), '保存编辑器高度');
  }

  setEditorHeight(getEditorHeight());

  const onResizePointerMove = (event) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    setEditorHeight(resizeStart.height + event.clientY - resizeStart.y);
  };
  const onResizePointerEnd = (event) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    resizeStart = null;
    if (resizeEl.hasPointerCapture(event.pointerId)) resizeEl.releasePointerCapture(event.pointerId);
    persistEditorHeight();
  };
  const onResizePointerDown = (event) => {
    event.preventDefault();
    resizeStart = { pointerId: event.pointerId, y: event.clientY, height: editorHost.offsetHeight };
    resizeEl.setPointerCapture(event.pointerId);
  };
  const onResizeKeydown = (event) => {
    const step = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowUp') setEditorHeight(editorHost.offsetHeight - step);
    else if (event.key === 'ArrowDown') setEditorHeight(editorHost.offsetHeight + step);
    else if (event.key === 'Home') setEditorHeight(minEditorHeight);
    else if (event.key === 'End') setEditorHeight(maxEditorHeight());
    else return;
    event.preventDefault();
    persistEditorHeight();
  };
  resizeEl.addEventListener('pointerdown', onResizePointerDown);
  resizeEl.addEventListener('pointermove', onResizePointerMove);
  resizeEl.addEventListener('pointerup', onResizePointerEnd);
  resizeEl.addEventListener('pointercancel', onResizePointerEnd);
  resizeEl.addEventListener('keydown', onResizeKeydown);

  // 快捷键：Cmd/Ctrl + Enter 判题；Alt+←/→ 切换上/下一题（焦点在编辑器或输入框时不劫持）
  const onKeydown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      run();
      return;
    }
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const target = event.target;
      const inEditable =
        target.closest('input, textarea, select, [contenteditable="true"]') ||
        target.closest('.monaco-editor') ||
        target.isContentEditable;
      if (inEditable) return;
      const dest = event.key === 'ArrowLeft' ? prev : next;
      if (dest) {
        event.preventDefault();
        location.hash = `#/problem/${dest.id}`;
      }
    }
  };
  document.addEventListener('keydown', onKeydown);

  const onPageHide = () => flushDraft();
  window.addEventListener('pagehide', onPageHide);

  // Python 实时语法检查（Pyodide 加载完成后才开启，输入停顿 800ms 后触发）
  createEditor(editorHost, {
    language: state.lang,
    value: initialCode(),
    onChange: (value) => {
      reportStorage(stageDraft(problem.id, state.mode, state.lang, value), '暂存草稿');
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => reportStorage(flushDrafts(), '保存草稿'), 400);
      editor?.clearError();
      const snapshot = Object.freeze({ code: value, lang: state.lang });
      const token = ++syntaxToken;
      clearTimeout(syntaxTimer);
      if (snapshot.lang !== 'python' || !isPythonReady()) return;
      syntaxTimer = setTimeout(async () => {
        const result = await checkPythonSyntax(snapshot.code);
        if (!validRoute(token, syntaxToken) || !editor || state.lang !== snapshot.lang) return;
        if (result && result.ok === false && result.line) editor.setError(result.line, result.error);
        else editor.clearError();
      }, 800);
    },
  }).then((createdEditor) => {
    if (disposed) {
      createdEditor.dispose();
      return;
    }
    editor = createdEditor;
    editor.setFontSize(editorFontSize);
    if (!mobileMedia.matches || state.mobileTab === 'code') editor.layout?.();
  });

  // 供 AI 助手读取当前编辑器草稿（作为提问上下文）
  registerDraftProvider(() => ({
    lang: state.lang,
    mode: state.mode,
    code: editor ? editor.getValue() : '',
  }));

  return () => {
    invalidateAsync();
    registerDraftProvider(null);
    flushDraft();
    directory.dispose();
    clearTimeout(customInputTimer);
    reportStorage(saveCustomInput(problem.id, state.mode, $('#custom-input').value), '保存自定义输入');
    disposed = true;
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('pagehide', onPageHide);
    mobileMedia.removeEventListener('change', onMobileMediaChange);
    editorHost.removeEventListener('wheel', onEditorWheel, true);
    resizeEl.removeEventListener('pointerdown', onResizePointerDown);
    resizeEl.removeEventListener('pointermove', onResizePointerMove);
    resizeEl.removeEventListener('pointerup', onResizePointerEnd);
    resizeEl.removeEventListener('pointercancel', onResizePointerEnd);
    resizeEl.removeEventListener('keydown', onResizeKeydown);
    clearTimeout(draftTimer);
    clearTimeout(syntaxTimer);
    container.classList.remove('app-wide');
    editor?.dispose();
    editor = null;
  };
}
