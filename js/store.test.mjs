import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor(entries = {}) {
    this.data = new Map(Object.entries(entries));
    this.failOnceFor = null;
  }
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) {
    if (this.failOnceFor === key) {
      this.failOnceFor = null;
      throw new Error('quota');
    }
    this.data.set(String(key), String(value));
  }
  removeItem(key) { this.data.delete(key); }
  clear() { this.data.clear(); }
}

globalThis.localStorage = new MemoryStorage();

const store = await import('./store.js');
const learningModel = await import('./learning.js');
const review = await import('./review.js');
const recommend = await import('./recommend.js');

function reset(entries = {}) {
  globalThis.localStorage = new MemoryStorage(entries);
}

function draftStorageKeys() {
  return [...localStorage.data.keys()].filter(key => key.startsWith('hot100_draft_v2:'));
}

test('偏好写入返回显式结果，存储失败不抛出', () => {
  reset();
  assert.deepEqual(store.setLangPref('javascript'), { ok: true });
  assert.equal(store.getLangPref(), 'javascript');
  localStorage.failOnceFor = 'hot100_theme_v1';
  const result = store.setThemePref('dark');
  assert.equal(result.ok, false);
  assert.equal(result.operation, 'write');
  assert.equal(store.getThemePref(), 'light');
});

test('列表视图、折叠分组和编辑器高度安全持久化', () => {
  reset();
  assert.equal(store.getListView(), 'diff');
  assert.deepEqual(store.getCollapsedGroups(), []);
  assert.equal(store.getEditorHeight(), 400);

  assert.deepEqual(store.setListView('diff'), { ok: true });
  assert.deepEqual(store.setListView('tags'), { ok: true });
  assert.deepEqual(store.setCollapsedGroups(['数组', '链表', '数组']), { ok: true });
  assert.deepEqual(store.setEditorHeight(680), { ok: true });
  assert.equal(store.getListView(), 'tags');
  assert.deepEqual(store.getCollapsedGroups(), ['数组', '链表']);
  assert.equal(store.getEditorHeight(), 680);
  assert.deepEqual(JSON.parse(localStorage.getItem('hot100_collapsed_groups_v1')), ['数组', '链表']);
});

test('代码字号持久化、边界与存储失败', () => {
  reset();
  assert.equal(store.getEditorFontSize(), 13);
  for (const size of [10, 18, 32]) {
    assert.deepEqual(store.setEditorFontSize(size), { ok: true });
    assert.equal(store.getEditorFontSize(), size);
  }
  for (const size of [9, 33, 13.5, NaN, Infinity, '18', null]) {
    assert.equal(store.setEditorFontSize(size).ok, false);
    assert.equal(store.getEditorFontSize(), 32);
  }
  for (const raw of ['', 'bad', '9', '33', '13.5']) {
    reset({ hot100_editor_font_size_v1: raw });
    assert.equal(store.getEditorFontSize(), 13);
  }
  reset();
  localStorage.failOnceFor = 'hot100_editor_font_size_v1';
  assert.equal(store.setEditorFontSize(18).ok, false);
  assert.equal(store.getEditorFontSize(), 13);
});

test('代码字号随备份恢复，旧备份兼容且无效字号不会写入', () => {
  reset();
  store.setEditorFontSize(18);
  const payload = store.exportAll();
  assert.equal(payload.data.preferences.editorFontSize, 18);
  for (const mode of ['merge', 'replace']) {
    reset();
    assert.equal(store.importAll(payload, { mode }).ok, true);
    assert.equal(store.getEditorFontSize(), 18);
  }
  for (const size of [9, 33, 13.5, '18', null]) {
    const corrupt = structuredClone(payload);
    corrupt.data.preferences.editorFontSize = size;
    assert.throws(() => store.importAll(corrupt), /代码字号格式/);
    assert.equal(store.getEditorFontSize(), 18);
  }
  delete payload.data.preferences.editorFontSize;
  assert.equal(store.importAll(payload, { mode: 'merge' }).ok, true);
  assert.equal(store.getEditorFontSize(), 18);
  assert.equal(store.importAll(payload, { mode: 'replace' }).ok, true);
  assert.equal(store.getEditorFontSize(), 13);
});

test('AI 助手配置安全持久化，损坏值回退默认', () => {
  reset();
  assert.deepEqual(store.getAssistantConfig(), { preset: 'moonshot', baseUrl: '', apiKey: '', model: '', pinned: false });

  assert.deepEqual(store.setAssistantConfig({
    preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'sk-x', model: 'deepseek-chat', pinned: true,
  }), { ok: true });
  // baseUrl 尾部斜杠被裁剪，pinned 持久化
  assert.deepEqual(store.getAssistantConfig(), {
    preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat', pinned: true,
  });

  for (const result of [
    store.setAssistantConfig(null),
    store.setAssistantConfig({ preset: 'x', baseUrl: 'ftp://bad', apiKey: '', model: '' }),
    store.setAssistantConfig({ preset: 'x', baseUrl: '', apiKey: 123, model: '' }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.operation, 'validate');
  }

  reset({ hot100_assistant_v1: '{"preset":1}' });
  assert.deepEqual(store.getAssistantConfig(), { preset: 'moonshot', baseUrl: '', apiKey: '', model: '', pinned: false });
});

test('新偏好拒绝非法写入并对损坏存储值使用安全默认值', () => {
  reset({
    hot100_list_view_v1: 'grid',
    hot100_collapsed_groups_v1: JSON.stringify(['数组', 1]),
    hot100_editor_height_v1: '9999',
  });
  assert.equal(store.getListView(), 'diff');
  assert.deepEqual(store.getCollapsedGroups(), []);
  assert.equal(store.getEditorHeight(), 400);

  for (const result of [
    store.setListView('grid'),
    store.setCollapsedGroups(['数组', null]),
    store.setEditorHeight(199),
    store.setEditorHeight(Number.NaN),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.operation, 'validate');
    assert.ok(result.error instanceof TypeError);
  }
  assert.equal(localStorage.getItem('hot100_list_view_v1'), 'grid');
  assert.equal(localStorage.getItem('hot100_editor_height_v1'), '9999');
});

test('新偏好写入失败返回显式存储错误', () => {
  reset();
  localStorage.failOnceFor = 'hot100_editor_height_v1';
  const result = store.setEditorHeight(500);
  assert.equal(result.ok, false);
  assert.equal(result.operation, 'write');
  assert.equal(store.getEditorHeight(), 400);
});

test('旧聚合草稿幂等迁移为逐草稿 key，并保留空草稿', () => {
  reset({
    hot100_drafts_v1: JSON.stringify({
      '1:core:python': '',
      '2:acm:javascript': 'return 2;',
    }),
  });
  assert.equal(store.getDraft(1, 'core', 'python'), '');
  assert.equal(store.getDraft(2, 'acm', 'javascript'), 'return 2;');
  assert.equal(localStorage.getItem('hot100_drafts_v1'), null);
  assert.equal(draftStorageKeys().length, 2);
  assert.equal(store.getDraft('missing', 'core', 'python'), null);
  assert.equal(draftStorageKeys().length, 2);
});

test('草稿暂存可统一 flush，失败时保留待写内容以便重试', () => {
  reset();
  assert.equal(store.stageDraft(1, 'core', 'python', 'first').ok, true);
  assert.equal(store.stageDraft(2, 'core', 'python', 'second').ok, true);
  const failingKey = `hot100_draft_v2:${encodeURIComponent(JSON.stringify(['2', 'core', 'python']))}`;
  localStorage.failOnceFor = failingKey;
  const failed = store.flushDrafts();
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(draftStorageKeys().length, 0);
  assert.deepEqual(store.flushDrafts(), { ok: true, flushed: 2 });
  assert.equal(store.getDraft(1, 'core', 'python'), 'first');
});

test('草稿执行 1 MiB 限制', () => {
  reset();
  const result = store.saveDraft(1, 'core', 'python', 'x'.repeat(store.MAX_DRAFT_BYTES + 1));
  assert.equal(result.ok, false);
  assert.equal(draftStorageKeys().length, 0);
});

test('旧 progress/mistakes 幂等迁移到 version 2 学习状态', () => {
  reset({
    hot100_progress_v1: JSON.stringify({ 1: { core: { solved: true, attempts: 2 } } }),
    hot100_mistakes_v1: JSON.stringify({ 1: { addedAt: 10, fails: 1, lastMode: 'core' } }),
  });
  const first = store.getLearningState();
  const persisted = localStorage.getItem('hot100_learning_v2');
  const second = store.getLearningState();
  assert.equal(first.version, 2);
  assert.equal(first.problems['1'].mastery, 'independent');
  assert.equal(first.problems['1'].rounds, 2);
  assert.equal(first.problems['1'].mistake.fails, 1);
  assert.equal(localStorage.getItem('hot100_learning_v2'), persisted);
  assert.deepEqual(second, first);
});

test('记录独立/借助通过、学习轮次与有限历史', () => {
  let state = learningModel.emptyLearningState();
  state = learningModel.applyLearningAttempt(state, { problemId: 1, mode: 'core', outcome: 'pass', assisted: true, at: 1 });
  assert.equal(state.problems['1'].mastery, 'assisted');
  state = learningModel.applyLearningAttempt(state, { problemId: 1, mode: 'core', outcome: 'pass', assisted: false, at: 2 });
  assert.equal(state.problems['1'].mastery, 'independent');
  for (let i = 0; i < 55; i++) state = learningModel.applyLearningAttempt(state, { problemId: 1, mode: 'acm', outcome: 'error', at: i + 3 });
  assert.equal(state.problems['1'].rounds, 57);
  assert.equal(state.problems['1'].history.length, learningModel.MAX_HISTORY);
});

test('失败记录错误原因和笔记，并按照次日/3天/7天复习', () => {
  reset();
  const at = 1_000_000;
  assert.equal(store.recordLearningAttempt(7, 'core', 'fail', { at }).ok, true);
  assert.equal(store.updateMistakeDetails(7, { reason: '边界遗漏', note: '先枚举空输入' }).ok, true);
  let state = store.getLearningState();
  assert.equal(state.problems['7'].mistake.reason, '边界遗漏');
  assert.equal(state.problems['7'].mistake.note, '先枚举空输入');
  assert.equal(state.problems['7'].review.dueAt, at + 86400000);

  let scheduled = review.scheduleFirstReview(at);
  scheduled = review.recordReview(scheduled, true, at + 86400000);
  assert.equal(scheduled.dueAt, at + 86400000 + 3 * 86400000);
  scheduled = review.recordReview(scheduled, true, scheduled.dueAt);
  assert.equal(scheduled.dueAt, at + 4 * 86400000 + 7 * 86400000);
  scheduled = review.recordReview(scheduled, true, scheduled.dueAt);
  assert.equal(scheduled.dueAt, 0);
  assert.equal(review.recordReview(scheduled, false, at).dueAt, at + 86400000);
});

test('今日推荐确定且优先到期复习，去重并受 limit 限制', () => {
  const at = Date.parse('2026-07-17T12:00:00Z');
  const state = {
    problems: {
      1: { review: { dueAt: at - 1 }, mistake: {}, mastery: null },
      2: { mistake: {}, mastery: null },
      3: { mastery: 'independent' },
    },
  };
  const first = recommend.recommendToday([3, 2, 1, 2, 4], state, { at, limit: 3 });
  const second = recommend.recommendToday([3, 2, 1, 2, 4], state, { at, limit: 3 });
  assert.deepEqual(first, second);
  assert.equal(first[0], '1');
  assert.equal(first.length, 3);
  assert.equal(new Set(first).size, 3);
});

test('version 2 导出采用严格 schema，并支持偏好 merge/replace', () => {
  reset({ hot100_unknown_v1: 'old' });
  store.setListView('tags');
  store.setCollapsedGroups(['数组', '链表', '数组']);
  store.setEditorHeight(720);
  store.saveDraft(1, 'core', 'python', 'code');
  const payload = store.exportAll();
  assert.deepEqual(Object.keys(payload).sort(), ['app', 'data', 'exportedAt', 'version']);
  assert.deepEqual(Object.keys(payload.data).sort(), ['customInputs', 'drafts', 'learning', 'mistakes', 'preferences', 'progress']);
  assert.deepEqual(payload.data.preferences, {
    lang: 'python', theme: 'light', listView: 'tags',
    collapsedGroups: ['数组', '链表'], editorHeight: 720, editorFontSize: 13,
    listFilters: { q: '', diff: '', tag: '', status: '' }, onboardingDismissed: false,
  });
  assert.equal(payload.version, 2);

  const withExtra = structuredClone(payload);
  withExtra.data.preferences.unknown = true;
  assert.throws(() => store.importAll(withExtra), /偏好设置格式/);
  for (const [field, value] of [['listView', 'grid'], ['collapsedGroups', ['数组', 1]], ['editorHeight', 1201]]) {
    const corrupt = structuredClone(payload);
    corrupt.data.preferences[field] = value;
    assert.throws(() => store.importAll(corrupt), /格式/);
  }

  reset({ hot100_unknown_v1: 'keep', hot100_list_view_v1: 'flat' });
  assert.equal(store.importAll(payload, { mode: 'merge' }).ok, true);
  assert.equal(localStorage.getItem('hot100_unknown_v1'), 'keep');
  assert.equal(store.getListView(), 'tags');
  assert.deepEqual(store.getCollapsedGroups(), ['数组', '链表']);
  assert.equal(store.getEditorHeight(), 720);
  assert.equal(store.getDraft(1, 'core', 'python'), 'code');

  localStorage.setItem('hot100_unknown_v1', 'remove');
  localStorage.setItem('hot100_collapsed_groups_v1', JSON.stringify(['临时']));
  assert.equal(store.importAll(payload, { mode: 'replace' }).ok, true);
  assert.equal(localStorage.getItem('hot100_unknown_v1'), null);
  assert.deepEqual(store.getCollapsedGroups(), ['数组', '链表']);
});

test('version 1 白名单导入迁移草稿、学习状态和旧偏好 key', () => {
  reset();
  const payload = {
    app: 'hot100', version: 1, exportedAt: new Date().toISOString(),
    data: {
      hot100_progress_v1: JSON.stringify({ 9: { acm: { solved: true, attempts: 3 } } }),
      hot100_mistakes_v1: JSON.stringify({}),
      hot100_drafts_v1: JSON.stringify({ '9:acm:python': '' }),
      hot100_list_view_v1: 'tags',
      hot100_collapsed_groups_v1: JSON.stringify(['动态规划', '动态规划', '图']),
      hot100_editor_height_v1: '640',
    },
  };
  assert.equal(store.importAll(payload).ok, true);
  assert.equal(store.getDraft(9, 'acm', 'python'), '');
  assert.equal(store.getLearningState().problems['9'].rounds, 3);
  assert.equal(store.getListView(), 'tags');
  assert.deepEqual(store.getCollapsedGroups(), ['动态规划', '图']);
  assert.equal(store.getEditorHeight(), 640);
  assert.equal(localStorage.getItem('hot100_drafts_v1'), null);

  const unknown = { app: 'hot100', version: 1, data: { hot100_untrusted_v1: 'value' } };
  assert.throws(() => store.importAll(unknown), /白名单/);
  assert.equal(localStorage.getItem('hot100_untrusted_v1'), null);
});

test('导入先预检，写入中失败则回滚并回读确认', () => {
  reset({ hot100_lang_v1: 'python', hot100_preserved_v1: 'yes' });
  const payload = store.exportAll();
  payload.data.preferences.lang = 'javascript';
  localStorage.failOnceFor = 'hot100_progress_v1';
  assert.throws(() => store.importAll(payload, { mode: 'replace' }), error => {
    assert.equal(error.rolledBack, true);
    return /导入失败/.test(error.message);
  });
  assert.equal(localStorage.getItem('hot100_lang_v1'), 'python');
  assert.equal(localStorage.getItem('hot100_preserved_v1'), 'yes');
});

test('导入拒绝超过 5 MiB 的 payload，且不产生写入', () => {
  reset({ hot100_lang_v1: 'python' });
  const huge = { app: 'hot100', version: 1, data: { hot100_other_v1: 'x'.repeat(store.MAX_BACKUP_BYTES) } };
  assert.throws(() => store.importAll(huge), /5 MiB/);
  assert.equal(localStorage.getItem('hot100_other_v1'), null);
  assert.equal(localStorage.getItem('hot100_lang_v1'), 'python');
});

test('辅助状态按题持久化在 learning v2，非法值拒绝且不写存储', () => {
  reset();
  assert.deepEqual(store.getAssistState(1), { assisted: false, hintLevel: 0, revealed: false });
  assert.deepEqual(store.setAssistState(1, { assisted: true, hintLevel: 2, revealed: false }), { ok: true });
  assert.deepEqual(store.getAssistState(1), { assisted: true, hintLevel: 2, revealed: false });
  const stored = JSON.parse(localStorage.getItem('hot100_learning_v2'));
  assert.deepEqual(stored.problems['1'].assist, { assisted: true, hintLevel: 2, revealed: false });

  const before = localStorage.getItem('hot100_learning_v2');
  for (const bad of [
    null, undefined, [], 'x',
    { assisted: 'yes', hintLevel: 1, revealed: false },
    { assisted: true, hintLevel: 5, revealed: false },
    { assisted: true, hintLevel: -1, revealed: false },
    { assisted: true, hintLevel: 1.5, revealed: false },
    { assisted: true, hintLevel: 1, revealed: 0 },
  ]) {
    const result = store.setAssistState(1, bad);
    assert.equal(result.ok, false);
    assert.equal(result.operation, 'validate');
    assert.ok(result.error instanceof TypeError);
  }
  assert.equal(localStorage.getItem('hot100_learning_v2'), before);
  assert.deepEqual(store.getAssistState(1), { assisted: true, hintLevel: 2, revealed: false });

  assert.deepEqual(store.clearAssistState(1), { ok: true, changed: true });
  assert.deepEqual(store.clearAssistState(1), { ok: true, changed: false });
  assert.deepEqual(store.getAssistState(1), { assisted: false, hintLevel: 0, revealed: false });
});

test('辅助状态在学习记录、错题与复习写入后保留', () => {
  reset();
  store.recordLearningAttempt(2, 'core', 'pass', { at: 1000 });
  store.setAssistState(2, { assisted: true, hintLevel: 3, revealed: true });
  store.recordLearningAttempt(2, 'acm', 'fail', { at: 2000 });
  assert.deepEqual(store.getAssistState(2), { assisted: true, hintLevel: 3, revealed: true });
  store.updateMistakeDetails(2, { reason: '边界', note: '枚举空输入' });
  assert.deepEqual(store.getAssistState(2), { assisted: true, hintLevel: 3, revealed: true });
  store.recordProblemReview(2, true, 3000);
  assert.deepEqual(store.getAssistState(2), { assisted: true, hintLevel: 3, revealed: true });
  store.removeMistake(2);
  assert.deepEqual(store.getAssistState(2), { assisted: true, hintLevel: 3, revealed: true });
  store.addMistake(2);
  assert.deepEqual(store.getAssistState(2), { assisted: true, hintLevel: 3, revealed: true });

  const problem = store.getLearningState().problems['2'];
  assert.equal(problem.modes.core.solved, true);
  assert.equal(problem.modes.acm.attempts, 1);
});

test('辅助状态随 version 2 备份导出导入，损坏项被丢弃', () => {
  reset();
  store.setAssistState(3, { assisted: true, hintLevel: 4, revealed: true });
  const payload = store.exportAll();
  assert.deepEqual(payload.data.learning.problems['3'].assist, { assisted: true, hintLevel: 4, revealed: true });

  reset();
  assert.equal(store.importAll(payload, { mode: 'replace' }).ok, true);
  assert.deepEqual(store.getAssistState(3), { assisted: true, hintLevel: 4, revealed: true });

  const corrupt = structuredClone(payload);
  corrupt.data.learning.problems['3'].assist = { assisted: 'yes', hintLevel: 9, revealed: 1 };
  reset();
  assert.equal(store.importAll(corrupt, { mode: 'replace' }).ok, true);
  assert.deepEqual(store.getAssistState(3), { assisted: false, hintLevel: 0, revealed: false });
});

test('自定义测试输入按题和模式持久化，限制单条大小并淘汰最旧', () => {
  reset();
  assert.equal(store.getCustomInput(1, 'core'), '');
  assert.deepEqual(store.saveCustomInput(1, 'core', '[1,2]'), { ok: true });
  assert.deepEqual(store.saveCustomInput(1, 'acm', '2\n1 2'), { ok: true });
  assert.equal(store.getCustomInput(1, 'core'), '[1,2]');
  assert.equal(store.getCustomInput(1, 'acm'), '2\n1 2');
  assert.equal(store.getCustomInput(2, 'core'), '');

  const oversized = store.saveCustomInput(1, 'core', 'x'.repeat(store.MAX_CUSTOM_INPUT_BYTES + 1));
  assert.equal(oversized.ok, false);
  assert.equal(store.getCustomInput(1, 'core'), '[1,2]');
  assert.equal(store.saveCustomInput(1, 'core', 'x'.repeat(store.MAX_CUSTOM_INPUT_BYTES)).ok, true);

  for (let i = 0; i < 130; i++) assert.equal(store.saveCustomInput(`p${i}`, 'core', `v${i}`).ok, true);
  const entries = JSON.parse(localStorage.getItem('hot100_custom_v1'));
  assert.equal(Object.keys(entries).length, store.MAX_CUSTOM_INPUTS);
  assert.equal(store.getCustomInput('p0', 'core'), '');
  assert.equal(store.getCustomInput('p129', 'core'), 'v129');
});

test('自定义输入存储损坏时回退空串', () => {
  reset({ hot100_custom_v1: 'not-json' });
  assert.equal(store.getCustomInput(1, 'core'), '');

  reset({
    hot100_custom_v1: JSON.stringify({
      bad: { text: 1, at: 0 },
      worse: 'nope',
      [JSON.stringify(['1', 'core'])]: { text: 'ok', at: 1 },
    }),
  });
  assert.equal(store.getCustomInput(1, 'core'), 'ok');
  assert.equal(store.getCustomInput('bad', 'core'), '');
});

test('自定义输入纳入 version 2 备份的 merge/replace 与严格校验', () => {
  reset();
  store.saveCustomInput(5, 'core', 'input-5');
  const payload = store.exportAll();
  assert.equal(payload.data.customInputs[JSON.stringify(['5', 'core'])].text, 'input-5');

  reset();
  assert.equal(store.importAll(payload, { mode: 'merge' }).ok, true);
  assert.equal(store.getCustomInput(5, 'core'), 'input-5');

  const withoutCustom = structuredClone(payload);
  delete withoutCustom.data.customInputs;
  assert.equal(store.importAll(withoutCustom, { mode: 'replace' }).ok, true);
  assert.equal(store.getCustomInput(5, 'core'), '');

  const corrupt = structuredClone(payload);
  corrupt.data.customInputs[JSON.stringify(['6', 'core'])] = { text: 1, at: 0 };
  assert.throws(() => store.importAll(corrupt), /自定义输入/);
});

test('列表筛选偏好非法字段回退空串并纳入备份 preferences', () => {
  reset();
  assert.deepEqual(store.getListFilters(), { q: '', diff: '', tag: '', status: '' });
  assert.deepEqual(store.setListFilters({ q: '回文', diff: 'medium', tag: 'dp', status: 'solved' }), { ok: true });
  assert.deepEqual(store.getListFilters(), { q: '回文', diff: 'medium', tag: 'dp', status: 'solved' });

  assert.equal(store.setListFilters({ q: 1, diff: null, tag: '数组' }).ok, true);
  assert.deepEqual(store.getListFilters(), { q: '', diff: '', tag: '数组', status: '' });

  reset({ hot100_list_filters_v1: 'corrupt' });
  assert.deepEqual(store.getListFilters(), { q: '', diff: '', tag: '', status: '' });

  reset();
  store.setListFilters({ q: '回文', diff: '', tag: '', status: '' });
  const payload = store.exportAll();
  assert.deepEqual(payload.data.preferences.listFilters, { q: '回文', diff: '', tag: '', status: '' });
  reset();
  assert.equal(store.importAll(payload, { mode: 'merge' }).ok, true);
  assert.deepEqual(store.getListFilters(), { q: '回文', diff: '', tag: '', status: '' });

  const corrupt = structuredClone(payload);
  corrupt.data.preferences.listFilters = { q: 1, diff: '', tag: '', status: '' };
  assert.throws(() => store.importAll(corrupt), /列表筛选/);
});

test('新手引导关闭偏好按布尔持久化并纳入备份 preferences', () => {
  reset();
  assert.equal(store.getOnboardingDismissed(), false);
  assert.deepEqual(store.setOnboardingDismissed(true), { ok: true });
  assert.equal(store.getOnboardingDismissed(), true);
  assert.equal(localStorage.getItem('hot100_onboarding_dismissed_v1'), 'true');
  assert.equal(store.setOnboardingDismissed(false).ok, true);
  assert.equal(store.getOnboardingDismissed(), false);

  reset({ hot100_onboarding_dismissed_v1: 'corrupt' });
  assert.equal(store.getOnboardingDismissed(), false);

  reset();
  store.setOnboardingDismissed(true);
  const payload = store.exportAll();
  assert.equal(payload.data.preferences.onboardingDismissed, true);
  reset();
  assert.equal(store.importAll(payload, { mode: 'merge' }).ok, true);
  assert.equal(store.getOnboardingDismissed(), true);

  const corrupt = structuredClone(payload);
  corrupt.data.preferences.onboardingDismissed = 'yes';
  assert.throws(() => store.importAll(corrupt), /新手引导/);
});
