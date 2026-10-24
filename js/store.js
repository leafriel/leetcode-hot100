// 唯一的 localStorage 边界：兼容旧接口，并提供版本化学习、草稿与备份 API。

import {
  applyLearningAttempt,
  clearLearningMistake,
  emptyLearningState,
  migrateLegacyLearning,
  normalizeLearningState,
  setLearningMistake,
} from './learning.js';
import { recordReview, scheduleFirstReview } from './review.js';

const PROGRESS_KEY = 'hot100_progress_v1';
const LEGACY_DRAFTS_KEY = 'hot100_drafts_v1';
const DRAFT_PREFIX = 'hot100_draft_v2:';
const MISTAKES_KEY = 'hot100_mistakes_v1';
const LEARNING_KEY = 'hot100_learning_v2';
const LANG_KEY = 'hot100_lang_v1';
const THEME_KEY = 'hot100_theme_v1';
const LIST_VIEW_KEY = 'hot100_list_view_v1';
const COLLAPSED_GROUPS_KEY = 'hot100_collapsed_groups_v1';
const EDITOR_HEIGHT_KEY = 'hot100_editor_height_v1';
const EDITOR_FONT_SIZE_KEY = 'hot100_editor_font_size_v1';
const CUSTOM_INPUTS_KEY = 'hot100_custom_v1';
const LIST_FILTERS_KEY = 'hot100_list_filters_v1';
const ONBOARDING_DISMISSED_KEY = 'hot100_onboarding_dismissed_v1';
const ASSISTANT_KEY = 'hot100_assistant_v1';
const NAMESPACE = 'hot100_';

const DEFAULT_LIST_VIEW = 'diff';
const LIST_VIEWS = ['diff', 'flat', 'tags'];
const DEFAULT_EDITOR_HEIGHT = 400;
const MIN_EDITOR_HEIGHT = 200;
const MAX_EDITOR_HEIGHT = 1200;
export const DEFAULT_EDITOR_FONT_SIZE = 13;
export const MIN_EDITOR_FONT_SIZE = 10;
export const MAX_EDITOR_FONT_SIZE = 32;

export const BACKUP_VERSION = 2;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
export const MAX_DRAFT_BYTES = 1024 * 1024;
export const MAX_CUSTOM_INPUT_BYTES = 64 * 1024;
export const MAX_CUSTOM_INPUTS = 120;

const LIST_FILTER_FIELDS = ['q', 'diff', 'tag', 'status'];

const encoder = new TextEncoder();
const pendingDrafts = new Map();

function byteLength(value) {
  return encoder.encode(value).byteLength;
}

function storageError(error, operation, key) {
  return { ok: false, error: error instanceof Error ? error : new Error(String(error)), operation, key };
}

function readRaw(key) {
  try {
    return { ok: true, value: localStorage.getItem(key) };
  } catch (error) {
    return storageError(error, 'read', key);
  }
}

function writeRaw(key, value) {
  try {
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== value) throw new Error('存储回读校验失败');
    return { ok: true };
  } catch (error) {
    return storageError(error, 'write', key);
  }
}

function removeRaw(key) {
  try {
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error('删除回读校验失败');
    return { ok: true };
  } catch (error) {
    return storageError(error, 'remove', key);
  }
}

function parseJson(raw, fallback) {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readJson(key, fallback) {
  const result = readRaw(key);
  return result.ok ? parseJson(result.value, fallback) : fallback;
}

function writeJson(key, value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    return storageError(error, 'serialize', key);
  }
  return writeRaw(key, serialized);
}

function listNamespace() {
  const entries = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(NAMESPACE)) entries[key] = localStorage.getItem(key);
    }
    return { ok: true, entries };
  } catch (error) {
    return storageError(error, 'list', NAMESPACE);
  }
}

function restoreSnapshot(snapshot) {
  const current = listNamespace();
  if (!current.ok) return current;
  for (const key of Object.keys(current.entries)) {
    const removed = removeRaw(key);
    if (!removed.ok) return removed;
  }
  for (const [key, value] of Object.entries(snapshot)) {
    const written = writeRaw(key, value);
    if (!written.ok) return written;
  }
  return { ok: true };
}

function transact(changes) {
  const snapshotResult = listNamespace();
  if (!snapshotResult.ok) return snapshotResult;
  for (const [key, value] of changes) {
    const result = value === null ? removeRaw(key) : writeRaw(key, value);
    if (!result.ok) {
      const rollback = restoreSnapshot(snapshotResult.entries);
      return { ...result, rolledBack: rollback.ok, rollbackError: rollback.ok ? undefined : rollback.error };
    }
  }
  return { ok: true };
}

function serialize(value) {
  return JSON.stringify(value);
}

export function getLangPref() {
  const result = readRaw(LANG_KEY);
  return result.ok && result.value ? result.value : 'python';
}

export function setLangPref(lang) {
  return writeRaw(LANG_KEY, String(lang));
}

export function getThemePref() {
  const result = readRaw(THEME_KEY);
  return result.ok && result.value ? result.value : 'light';
}

export function setThemePref(theme) {
  return writeRaw(THEME_KEY, String(theme));
}

function invalidPreference(key, message) {
  return storageError(new TypeError(message), 'validate', key);
}

export function getListView() {
  const result = readRaw(LIST_VIEW_KEY);
  return result.ok && LIST_VIEWS.includes(result.value) ? result.value : DEFAULT_LIST_VIEW;
}

export function setListView(view) {
  if (!LIST_VIEWS.includes(view)) return invalidPreference(LIST_VIEW_KEY, `列表视图必须是 ${LIST_VIEWS.join('、')} 之一`);
  return writeRaw(LIST_VIEW_KEY, view);
}

export function getCollapsedGroups() {
  const groups = readJson(COLLAPSED_GROUPS_KEY, []);
  if (!Array.isArray(groups) || groups.some(group => typeof group !== 'string')) return [];
  return [...new Set(groups)];
}

export function setCollapsedGroups(groups) {
  if (!Array.isArray(groups) || groups.some(group => typeof group !== 'string')) {
    return invalidPreference(COLLAPSED_GROUPS_KEY, '折叠分组必须是字符串数组');
  }
  return writeJson(COLLAPSED_GROUPS_KEY, [...new Set(groups)]);
}

// AI 助手（OpenAI 兼容）配置。apiKey 敏感：不进入 exportAll 备份字段。
const DEFAULT_ASSISTANT_CONFIG = { preset: 'moonshot', baseUrl: '', apiKey: '', model: '', pinned: false };

export function getAssistantConfig() {
  const cfg = readJson(ASSISTANT_KEY, null);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ...DEFAULT_ASSISTANT_CONFIG };
  return {
    preset: typeof cfg.preset === 'string' ? cfg.preset : DEFAULT_ASSISTANT_CONFIG.preset,
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
    apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
    model: typeof cfg.model === 'string' ? cfg.model : '',
    pinned: cfg.pinned === true,
  };
}

export function setAssistantConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return invalidPreference(ASSISTANT_KEY, '助手配置必须是对象');
  }
  const { preset, baseUrl, apiKey, model } = cfg;
  const pinned = cfg.pinned === true;
  if (typeof preset !== 'string' || preset.length > 40) return invalidPreference(ASSISTANT_KEY, '助手预设格式不正确');
  if (typeof baseUrl !== 'string' || baseUrl.length > 200) return invalidPreference(ASSISTANT_KEY, '助手接口地址格式不正确');
  if (baseUrl && !/^https?:\/\/\S+$/.test(baseUrl)) return invalidPreference(ASSISTANT_KEY, '助手接口地址必须是 http(s) URL');
  if (typeof apiKey !== 'string' || apiKey.length > 500) return invalidPreference(ASSISTANT_KEY, '助手 API Key 格式不正确');
  if (typeof model !== 'string' || model.length > 200) return invalidPreference(ASSISTANT_KEY, '助手模型名格式不正确');
  return writeJson(ASSISTANT_KEY, { preset, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, pinned });
}

export function getEditorHeight() {
  const result = readRaw(EDITOR_HEIGHT_KEY);
  if (!result.ok || result.value === null || result.value.trim() === '') return DEFAULT_EDITOR_HEIGHT;
  const height = Number(result.value);
  return Number.isFinite(height) && height >= MIN_EDITOR_HEIGHT && height <= MAX_EDITOR_HEIGHT
    ? height
    : DEFAULT_EDITOR_HEIGHT;
}

function validEditorFontSize(size) {
  return Number.isInteger(size) && size >= MIN_EDITOR_FONT_SIZE && size <= MAX_EDITOR_FONT_SIZE;
}

export function getEditorFontSize() {
  const result = readRaw(EDITOR_FONT_SIZE_KEY);
  const size = result.ok ? Number(result.value) : NaN;
  return validEditorFontSize(size) ? size : DEFAULT_EDITOR_FONT_SIZE;
}

export function setEditorFontSize(size) {
  if (!validEditorFontSize(size)) {
    return invalidPreference(EDITOR_FONT_SIZE_KEY, `代码字号必须是 ${MIN_EDITOR_FONT_SIZE}-${MAX_EDITOR_FONT_SIZE} 之间的整数`);
  }
  return writeRaw(EDITOR_FONT_SIZE_KEY, String(size));
}

export function setEditorHeight(height) {
  if (!Number.isFinite(height) || height < MIN_EDITOR_HEIGHT || height > MAX_EDITOR_HEIGHT) {
    return invalidPreference(EDITOR_HEIGHT_KEY, `编辑器高度必须在 ${MIN_EDITOR_HEIGHT}-${MAX_EDITOR_HEIGHT} 之间`);
  }
  return writeRaw(EDITOR_HEIGHT_KEY, String(height));
}

export function getProgress() {
  const progress = readJson(PROGRESS_KEY, {});
  return progress && typeof progress === 'object' && !Array.isArray(progress) ? progress : {};
}

// 辅助作答状态存放在 learning v2 的 problems[pid].assist。learning.js 的
// normalizeLearningState 会丢弃未知字段，因此所有读写路径都要经过这里的
// 收集/挂载来保留 assist，使其自然随学习状态与 version 2 备份流转。
function normalizeAssist(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.assisted !== 'boolean' || typeof value.revealed !== 'boolean') return null;
  if (!Number.isInteger(value.hintLevel) || value.hintLevel < 0 || value.hintLevel > 4) return null;
  return { assisted: value.assisted, hintLevel: value.hintLevel, revealed: value.revealed };
}

function collectAssistMap(source) {
  const map = {};
  const problems = source && source.problems;
  if (!problems || typeof problems !== 'object') return map;
  for (const [id, problem] of Object.entries(problems)) {
    const assist = problem && typeof problem === 'object' ? normalizeAssist(problem.assist) : null;
    if (assist) map[id] = assist;
  }
  return map;
}

function attachAssistMap(state, assistMap) {
  for (const [id, assist] of Object.entries(assistMap)) {
    if (state.problems[id]) state.problems[id].assist = assist;
  }
  return state;
}

function emptyProblemEntry() {
  return {
    modes: { core: { solved: false, attempts: 0 }, acm: { solved: false, attempts: 0 } },
    mastery: null,
    rounds: 0,
    history: [],
    mistake: null,
    review: null,
  };
}

export function getLearningState() {
  const raw = readJson(LEARNING_KEY, null);
  if (raw && raw.version === 2) return attachAssistMap(normalizeLearningState(raw), collectAssistMap(raw));
  const migrated = migrateLegacyLearning(getProgress(), getMistakes());
  writeJson(LEARNING_KEY, migrated);
  return migrated;
}

// 新接口可区分独立通过和借助通过；旧 recordAttempt 默认按独立作答处理。
export function recordLearningAttempt(problemId, mode, outcome, { assisted = false, at = Date.now() } = {}) {
  const progress = getProgress();
  const p = (progress[problemId] = progress[problemId] || {});
  const m = (p[mode] = p[mode] || { solved: false, attempts: 0 });
  m.attempts += 1;
  if (outcome === 'pass') m.solved = true;

  let mistakes = getMistakes();
  const current = getLearningState();
  const assistMap = collectAssistMap(current);
  let learning = applyLearningAttempt(current, { problemId, mode, outcome, assisted, at });
  if (outcome === 'fail') {
    const existing = mistakes[problemId];
    mistakes[problemId] = existing
      ? { ...existing, fails: (existing.fails || 0) + 1, lastMode: mode }
      : { addedAt: at, fails: 1, lastMode: mode };
    learning = setLearningMistake(learning, problemId, {
      addedAt: existing ? existing.addedAt : at,
      fails: mistakes[problemId].fails,
      lastMode: mode,
      reason: learning.problems[String(problemId)].mistake?.reason || '',
      note: learning.problems[String(problemId)].mistake?.note || '',
    });
    learning.problems[String(problemId)].review ||= scheduleFirstReview(at);
  }
  attachAssistMap(learning, assistMap);
  return transact([
    [PROGRESS_KEY, serialize(progress)],
    [MISTAKES_KEY, serialize(mistakes)],
    [LEARNING_KEY, serialize(learning)],
  ]);
}

export function recordAttempt(problemId, mode, outcome) {
  return recordLearningAttempt(problemId, mode, outcome);
}

export function problemStatus(problemId) {
  const p = getProgress()[problemId];
  if (!p) return 'none';
  if ((p.core && p.core.solved) || (p.acm && p.acm.solved)) return 'solved';
  if ((p.core && p.core.attempts > 0) || (p.acm && p.acm.attempts > 0)) return 'attempted';
  return 'none';
}

function draftId(problemId, mode, lang) {
  return JSON.stringify([String(problemId), String(mode), String(lang)]);
}

function draftKeyFromId(id) {
  return `${DRAFT_PREFIX}${encodeURIComponent(id)}`;
}

function migrateLegacyDrafts() {
  const legacyResult = readRaw(LEGACY_DRAFTS_KEY);
  if (!legacyResult.ok || legacyResult.value === null) return legacyResult.ok ? { ok: true, migrated: false } : legacyResult;
  const legacy = parseJson(legacyResult.value, null);
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return { ok: false, error: new Error('旧草稿数据格式无效') };
  const changes = [];
  for (const [id, code] of Object.entries(legacy)) {
    if (typeof code !== 'string') continue;
    const parts = id.split(':');
    if (parts.length < 3) continue;
    const lang = parts.pop();
    const mode = parts.pop();
    const problemId = parts.join(':');
    if (byteLength(code) > MAX_DRAFT_BYTES) return { ok: false, error: new Error(`草稿 ${id} 超过限制`) };
    changes.push([draftKeyFromId(draftId(problemId, mode, lang)), code]);
  }
  changes.push([LEGACY_DRAFTS_KEY, null]);
  const result = transact(changes);
  return result.ok ? { ok: true, migrated: true } : result;
}

export function getDraft(problemId, mode, lang) {
  migrateLegacyDrafts();
  const result = readRaw(draftKeyFromId(draftId(problemId, mode, lang)));
  return result.ok ? result.value : null;
}

export function saveDraft(problemId, mode, lang, code) {
  const value = String(code);
  if (byteLength(value) > MAX_DRAFT_BYTES) return { ok: false, error: new Error('草稿超过 1 MiB 限制') };
  migrateLegacyDrafts();
  return writeRaw(draftKeyFromId(draftId(problemId, mode, lang)), value);
}

export function clearDraft(problemId, mode, lang) {
  pendingDrafts.delete(draftId(problemId, mode, lang));
  migrateLegacyDrafts();
  return removeRaw(draftKeyFromId(draftId(problemId, mode, lang)));
}

// 视图可在输入时暂存，并在 pagehide 中直接调用 flushDrafts。
export function stageDraft(problemId, mode, lang, code) {
  const value = String(code);
  if (byteLength(value) > MAX_DRAFT_BYTES) return { ok: false, error: new Error('草稿超过 1 MiB 限制') };
  pendingDrafts.set(draftId(problemId, mode, lang), value);
  return { ok: true };
}

export function flushDrafts() {
  if (pendingDrafts.size === 0) return { ok: true, flushed: 0 };
  migrateLegacyDrafts();
  const changes = [...pendingDrafts].map(([id, code]) => [draftKeyFromId(id), code]);
  const result = transact(changes);
  if (result.ok) pendingDrafts.clear();
  return result.ok ? { ok: true, flushed: changes.length } : { ...result, flushed: 0 };
}

export function getMistakes() {
  const mistakes = readJson(MISTAKES_KEY, {});
  return mistakes && typeof mistakes === 'object' && !Array.isArray(mistakes) ? mistakes : {};
}

export function isMistake(problemId) {
  return Boolean(getMistakes()[problemId]);
}

export function addMistake(problemId) {
  const mistakes = getMistakes();
  if (mistakes[problemId]) return { ok: true, changed: false };
  const at = Date.now();
  mistakes[problemId] = { addedAt: at, fails: 0, lastMode: null };
  const current = getLearningState();
  let learning = setLearningMistake(current, problemId, { addedAt: at, fails: 0, lastMode: null, reason: '', note: '' });
  learning.problems[String(problemId)].review ||= scheduleFirstReview(at);
  attachAssistMap(learning, collectAssistMap(current));
  const result = transact([[MISTAKES_KEY, serialize(mistakes)], [LEARNING_KEY, serialize(learning)]]);
  return result.ok ? { ok: true, changed: true } : result;
}

export function removeMistake(problemId) {
  const mistakes = getMistakes();
  if (!mistakes[problemId]) return { ok: true, changed: false };
  delete mistakes[problemId];
  const current = getLearningState();
  const learning = attachAssistMap(clearLearningMistake(current, problemId), collectAssistMap(current));
  const result = transact([[MISTAKES_KEY, serialize(mistakes)], [LEARNING_KEY, serialize(learning)]]);
  return result.ok ? { ok: true, changed: true } : result;
}

export function updateMistakeDetails(problemId, { reason = '', note = '' } = {}) {
  const learning = getLearningState();
  if (!learning.problems[String(problemId)]?.mistake) return { ok: false, error: new Error('题目不在错题集中') };
  const updated = attachAssistMap(
    setLearningMistake(learning, problemId, { reason: String(reason), note: String(note) }),
    collectAssistMap(learning),
  );
  return writeJson(LEARNING_KEY, updated);
}

export function recordProblemReview(problemId, passed, at = Date.now()) {
  const learning = getLearningState();
  const problem = learning.problems[String(problemId)];
  if (!problem) return { ok: false, error: new Error('没有该题的学习记录') };
  problem.review = recordReview(problem.review, Boolean(passed), at);
  problem.history.push({ at, type: 'review', outcome: passed ? 'pass' : 'fail' });
  problem.history = problem.history.slice(-50);
  learning.revision += 1;
  return writeJson(LEARNING_KEY, learning);
}

export function getAssistState(problemId) {
  const assist = normalizeAssist(getLearningState().problems[String(problemId)]?.assist);
  return assist || { assisted: false, hintLevel: 0, revealed: false };
}

export function setAssistState(problemId, state) {
  const assist = normalizeAssist(state);
  if (!assist) return invalidPreference(LEARNING_KEY, '辅助状态必须是 {assisted:boolean, hintLevel:0-4, revealed:boolean}');
  const learning = getLearningState();
  const id = String(problemId);
  const problem = learning.problems[id] || (learning.problems[id] = emptyProblemEntry());
  problem.assist = assist;
  learning.revision += 1;
  return writeJson(LEARNING_KEY, learning);
}

export function clearAssistState(problemId) {
  const learning = getLearningState();
  const problem = learning.problems[String(problemId)];
  if (!problem || !problem.assist) return { ok: true, changed: false };
  delete problem.assist;
  learning.revision += 1;
  const result = writeJson(LEARNING_KEY, learning);
  return result.ok ? { ok: true, changed: true } : result;
}

function customInputId(problemId, mode) {
  return JSON.stringify([String(problemId), String(mode)]);
}

function normalizeCustomInputEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.text !== 'string' || !Number.isFinite(entry.at) || entry.at < 0) return null;
  return { text: entry.text, at: entry.at };
}

function readCustomInputs() {
  const raw = readJson(CUSTOM_INPUTS_KEY, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = {};
  for (const [id, entry] of Object.entries(raw)) {
    const normalized = normalizeCustomInputEntry(entry);
    if (normalized) entries[id] = normalized;
  }
  return entries;
}

function evictCustomInputs(entries) {
  const ids = Object.keys(entries);
  if (ids.length <= MAX_CUSTOM_INPUTS) return entries;
  ids.sort((a, b) => entries[a].at - entries[b].at);
  for (const id of ids.slice(0, ids.length - MAX_CUSTOM_INPUTS)) delete entries[id];
  return entries;
}

export function getCustomInput(problemId, mode) {
  const entry = readCustomInputs()[customInputId(problemId, mode)];
  return entry ? entry.text : '';
}

export function saveCustomInput(problemId, mode, text) {
  const value = String(text);
  if (byteLength(value) > MAX_CUSTOM_INPUT_BYTES) return { ok: false, error: new Error('自定义输入超过 64 KiB 限制') };
  const entries = readCustomInputs();
  entries[customInputId(problemId, mode)] = { text: value, at: Date.now() };
  return writeJson(CUSTOM_INPUTS_KEY, evictCustomInputs(entries));
}

function normalizeListFilters(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const filters = {};
  for (const field of LIST_FILTER_FIELDS) filters[field] = typeof source[field] === 'string' ? source[field] : '';
  return filters;
}

export function getListFilters() {
  return normalizeListFilters(readJson(LIST_FILTERS_KEY, {}));
}

export function setListFilters(filters) {
  return writeJson(LIST_FILTERS_KEY, normalizeListFilters(filters));
}

export function getOnboardingDismissed() {
  const result = readRaw(ONBOARDING_DISMISSED_KEY);
  return result.ok && result.value === 'true';
}

export function setOnboardingDismissed(value) {
  return writeRaw(ONBOARDING_DISMISSED_KEY, value ? 'true' : 'false');
}

function collectDrafts() {
  const migration = migrateLegacyDrafts();
  if (!migration.ok) return migration;
  const result = listNamespace();
  if (!result.ok) return result;
  const drafts = {};
  for (const [key, value] of Object.entries(result.entries)) {
    if (!key.startsWith(DRAFT_PREFIX)) continue;
    let id;
    try { id = decodeURIComponent(key.slice(DRAFT_PREFIX.length)); } catch { continue; }
    drafts[id] = value;
  }
  return { ok: true, drafts };
}

export function exportAll() {
  const draftResult = collectDrafts();
  if (!draftResult.ok) throw draftResult.error;
  const payload = {
    app: 'hot100',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      preferences: {
        lang: getLangPref(),
        theme: getThemePref(),
        listView: getListView(),
        collapsedGroups: getCollapsedGroups(),
        editorHeight: getEditorHeight(),
        editorFontSize: getEditorFontSize(),
        listFilters: getListFilters(),
        onboardingDismissed: getOnboardingDismissed(),
      },
      progress: getProgress(),
      mistakes: getMistakes(),
      learning: getLearningState(),
      drafts: draftResult.drafts,
      customInputs: readCustomInputs(),
    },
  };
  validateSize(payload);
  return payload;
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key))
    && allowed.every(key => Object.hasOwn(value, key));
}

function validateSize(payload) {
  let raw;
  try { raw = JSON.stringify(payload); } catch { throw new Error('备份无法序列化'); }
  if (byteLength(raw) > MAX_BACKUP_BYTES) throw new Error('备份超过 5 MiB 限制');
}

function v2Changes(payload) {
  if (!exactKeys(payload, ['app', 'version', 'exportedAt', 'data']) || payload.app !== 'hot100' || payload.version !== 2 || typeof payload.exportedAt !== 'string') {
    throw new Error('version 2 备份格式不正确');
  }
  const data = payload.data;
  const dataKeys = ['preferences', 'progress', 'mistakes', 'learning', 'drafts'];
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !dataKeys.every(key => Object.hasOwn(data, key))
    || Object.keys(data).some(key => !dataKeys.includes(key) && key !== 'customInputs')) {
    throw new Error('version 2 data schema 不正确');
  }
  const preferences = data.preferences;
  const preferenceKeys = ['lang', 'theme', 'listView', 'collapsedGroups', 'editorHeight', 'editorFontSize', 'listFilters', 'onboardingDismissed'];
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)
    || !Object.hasOwn(preferences, 'lang') || !Object.hasOwn(preferences, 'theme')
    || Object.keys(preferences).some(key => !preferenceKeys.includes(key))
    || typeof preferences.lang !== 'string' || typeof preferences.theme !== 'string') {
    throw new Error('偏好设置格式不正确');
  }
  if (preferences.listView !== undefined && !LIST_VIEWS.includes(preferences.listView)) throw new Error('列表视图格式不正确');
  if (preferences.collapsedGroups !== undefined
    && (!Array.isArray(preferences.collapsedGroups) || preferences.collapsedGroups.some(group => typeof group !== 'string'))) {
    throw new Error('折叠分组格式不正确');
  }
  if (preferences.editorHeight !== undefined
    && (!Number.isFinite(preferences.editorHeight) || preferences.editorHeight < MIN_EDITOR_HEIGHT || preferences.editorHeight > MAX_EDITOR_HEIGHT)) {
    throw new Error('编辑器高度格式不正确');
  }
  if (preferences.editorFontSize !== undefined && !validEditorFontSize(preferences.editorFontSize)) {
    throw new Error('代码字号格式不正确');
  }
  if (preferences.listFilters !== undefined) {
    const filters = preferences.listFilters;
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)
      || LIST_FILTER_FIELDS.some(field => typeof filters[field] !== 'string')) {
      throw new Error('列表筛选格式不正确');
    }
  }
  if (preferences.onboardingDismissed !== undefined && typeof preferences.onboardingDismissed !== 'boolean') {
    throw new Error('新手引导偏好格式不正确');
  }
  for (const field of ['progress', 'mistakes', 'drafts']) {
    if (!data[field] || typeof data[field] !== 'object' || Array.isArray(data[field])) throw new Error(`${field} 格式不正确`);
  }
  if (!data.learning || data.learning.version !== 2 || !data.learning.problems || typeof data.learning.problems !== 'object') throw new Error('learning 格式不正确');
  const changes = [
    [LANG_KEY, preferences.lang], [THEME_KEY, preferences.theme],
    [PROGRESS_KEY, serialize(data.progress)], [MISTAKES_KEY, serialize(data.mistakes)],
    [LEARNING_KEY, serialize(attachAssistMap(normalizeLearningState(data.learning), collectAssistMap(data.learning)))],
  ];
  if (preferences.listView !== undefined) changes.push([LIST_VIEW_KEY, preferences.listView]);
  if (preferences.collapsedGroups !== undefined) changes.push([COLLAPSED_GROUPS_KEY, serialize([...new Set(preferences.collapsedGroups)])]);
  if (preferences.editorHeight !== undefined) changes.push([EDITOR_HEIGHT_KEY, String(preferences.editorHeight)]);
  if (preferences.editorFontSize !== undefined) changes.push([EDITOR_FONT_SIZE_KEY, String(preferences.editorFontSize)]);
  if (preferences.listFilters !== undefined) changes.push([LIST_FILTERS_KEY, serialize(normalizeListFilters(preferences.listFilters))]);
  if (preferences.onboardingDismissed !== undefined) changes.push([ONBOARDING_DISMISSED_KEY, preferences.onboardingDismissed ? 'true' : 'false']);
  for (const [id, code] of Object.entries(data.drafts)) {
    if (typeof code !== 'string' || byteLength(code) > MAX_DRAFT_BYTES) throw new Error(`草稿 ${id} 格式无效或超过限制`);
    let tuple;
    try { tuple = JSON.parse(id); } catch { throw new Error(`草稿标识 ${id} 无效`); }
    if (!Array.isArray(tuple) || tuple.length !== 3 || tuple.some(value => typeof value !== 'string')) throw new Error(`草稿标识 ${id} 无效`);
    changes.push([draftKeyFromId(id), code]);
  }
  if (data.customInputs !== undefined) {
    if (!data.customInputs || typeof data.customInputs !== 'object' || Array.isArray(data.customInputs)) throw new Error('自定义输入格式不正确');
    const entries = {};
    for (const [id, entry] of Object.entries(data.customInputs)) {
      const normalized = normalizeCustomInputEntry(entry);
      if (!normalized || byteLength(normalized.text) > MAX_CUSTOM_INPUT_BYTES) throw new Error(`自定义输入 ${id} 格式无效或超过限制`);
      entries[id] = normalized;
    }
    changes.push([CUSTOM_INPUTS_KEY, serialize(evictCustomInputs(entries))]);
  }
  return changes;
}

function v1Changes(payload) {
  if (!payload || payload.app !== 'hot100' || payload.version !== 1 || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) throw new Error('version 1 备份格式不正确');
  const allowedKeys = new Set([
    PROGRESS_KEY, LEGACY_DRAFTS_KEY, MISTAKES_KEY, LANG_KEY, THEME_KEY,
    LIST_VIEW_KEY, COLLAPSED_GROUPS_KEY, EDITOR_HEIGHT_KEY,
  ]);
  const changes = [];
  for (const [key, value] of Object.entries(payload.data)) {
    if (!allowedKeys.has(key) || typeof value !== 'string') throw new Error(`version 1 数据项 ${key} 不在导入白名单中`);
    if (key === LIST_VIEW_KEY) {
      if (!LIST_VIEWS.includes(value)) throw new Error('version 1 列表视图格式不正确');
      changes.push([key, value]);
      continue;
    }
    if (key === COLLAPSED_GROUPS_KEY) {
      const groups = parseJson(value, null);
      if (!Array.isArray(groups) || groups.some(group => typeof group !== 'string')) throw new Error('version 1 折叠分组格式不正确');
      changes.push([key, serialize([...new Set(groups)])]);
      continue;
    }
    if (key === EDITOR_HEIGHT_KEY) {
      const height = Number(value);
      if (!Number.isFinite(height) || value.trim() === '' || height < MIN_EDITOR_HEIGHT || height > MAX_EDITOR_HEIGHT) throw new Error('version 1 编辑器高度格式不正确');
      changes.push([key, String(height)]);
      continue;
    }
    if (key !== LEGACY_DRAFTS_KEY) {
      changes.push([key, value]);
      continue;
    }
    const drafts = parseJson(value, null);
    if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts)) throw new Error('version 1 草稿格式不正确');
    for (const [legacyId, code] of Object.entries(drafts)) {
      if (typeof code !== 'string' || byteLength(code) > MAX_DRAFT_BYTES) throw new Error(`草稿 ${legacyId} 格式无效或超过限制`);
      const parts = legacyId.split(':');
      if (parts.length < 3) throw new Error(`草稿标识 ${legacyId} 无效`);
      const lang = parts.pop();
      const mode = parts.pop();
      changes.push([draftKeyFromId(draftId(parts.join(':'), mode, lang)), code]);
    }
    changes.push([LEGACY_DRAFTS_KEY, null]);
  }
  if (PROGRESS_KEY in payload.data || MISTAKES_KEY in payload.data) {
    const progress = parseJson(payload.data[PROGRESS_KEY] ?? null, {});
    const mistakes = parseJson(payload.data[MISTAKES_KEY] ?? null, {});
    if (!progress || typeof progress !== 'object' || !mistakes || typeof mistakes !== 'object') throw new Error('version 1 学习数据格式不正确');
    changes.push([LEARNING_KEY, serialize(migrateLegacyLearning(progress, mistakes))]);
  }
  return changes;
}

export function importAll(payload, { mode = 'merge' } = {}) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error('导入模式必须是 merge 或 replace');
  validateSize(payload);
  const incoming = payload?.version === 2 ? v2Changes(payload) : v1Changes(payload);
  const incomingMap = new Map(incoming);
  const changes = [];
  if (mode === 'replace') {
    const current = listNamespace();
    if (!current.ok) throw current.error;
    for (const key of Object.keys(current.entries)) if (!incomingMap.has(key)) changes.push([key, null]);
  }
  changes.push(...incoming);
  const result = transact(changes);
  if (!result.ok) {
    const error = new Error(`导入失败：${result.error.message}`);
    error.cause = result.error;
    error.rolledBack = result.rolledBack;
    throw error;
  }
  return { ok: true, imported: incoming.length, mode };
}

export function resetLearningState() {
  return writeJson(LEARNING_KEY, emptyLearningState());
}
