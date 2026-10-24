// Monaco 编辑器封装：CDN 加载，失败时降级为 textarea（保证离线/断网也能用）
// - JavaScript 接 TS 语言服务：输入时实时标语法错误（只开语法检查，避免全局变量误报）
// - setError/clearError：判题报错时在指定行标红并跳转
// - retry/upgrade：加载失败后可重试，并将降级编辑区中的内容无损升级到 Monaco

import { getThemePref, getEditorFontSize, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE } from './store.js';

const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';
// 本地自托管的 Monaco（vendor/monaco/vs），离线可用；缺失或加载失败时回退 CDN。
const MONACO_LOCAL = new URL('../vendor/monaco/vs', import.meta.url).href;
const INDENT = '    ';

// 降级 textarea 的 Tab 支持：Tab 插入 4 空格（选中跨行时整体缩进），Shift+Tab 取消缩进
// 与 js/views/knowledgeDetail.js 中的 handleIndentKeydown 行为保持一致
function handleIndentKeydown(event) {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const textarea = event.currentTarget;
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  if (!event.shiftKey && start === end) {
    textarea.value = value.slice(0, start) + INDENT + value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + INDENT.length;
  } else {
    const lineStart = value.slice(0, start).lastIndexOf('\n') + 1;
    const nextNl = value.indexOf('\n', end);
    const lineEnd = nextNl === -1 ? value.length : nextNl;
    const lines = value.slice(lineStart, lineEnd).split('\n');
    let firstShift = 0;
    let totalShift = 0;
    const nextLines = lines.map((line, index) => {
      if (event.shiftKey) {
        const match = line.match(/^( {1,4}|\t)/);
        const cut = match ? match[1].length : 0;
        if (index === 0) firstShift = cut;
        totalShift += cut;
        return line.slice(cut);
      }
      totalShift += INDENT.length;
      return INDENT + line;
    });
    textarea.value = value.slice(0, lineStart) + nextLines.join('\n') + value.slice(lineEnd);
    if (event.shiftKey) {
      textarea.selectionStart = Math.max(lineStart, start - firstShift);
      textarea.selectionEnd = Math.max(lineStart, end - totalShift);
    } else {
      textarea.selectionStart = start + INDENT.length;
      textarea.selectionEnd = end + totalShift;
    }
  }
  // 程序化修改后补发 input，让 onChange 等监听逻辑照常工作
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

let monacoPromise = null;
const configuredMonaco = new WeakSet();

function configureMonaco(monaco) {
  if (configuredMonaco.has(monaco)) return;

  // JS 只保留语法错误（红色波浪线）：
  // - 关语义检查（会把 input 等全局变量误报为未定义）
  // - 过滤建议级提示（未使用变量、隐式 any——对刷题代码全是噪音）
  const jsDefaults = monaco.languages.typescript.javascriptDefaults;
  jsDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [
      6133, 6192, 6196, 6198, 6199, 7005, 7006, 7017, 7019, 7026, 7027, 7034, 7044, 8006, 8016, 8020,
    ],
  });
  jsDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
  });
  configuredMonaco.add(monaco);
}

// 从指定 base（本地 vendor 或 CDN）加载 loader.js 与 editor.main。
function loadMonacoFrom(vsBase) {
  return new Promise((resolve, reject) => {
    const loadEditor = () => {
      if (!window.require || typeof window.require.config !== 'function') {
        reject(new Error('Monaco AMD 加载器不可用'));
        return;
      }

      // 所有 worker（含 TS 语言服务）都经 workerMain 引导：它按 workerId 自行加载 tsWorker 等模块
      // 注意 baseUrl 必须是 min/ 这一级（loader 会以它为根拼接 vs/... 模块路径）
      const baseUrl = vsBase.replace(/\/vs$/, '') + '/';
      window.MonacoEnvironment = {
        getWorker: () => {
          const workerUrl = URL.createObjectURL(
            new Blob(
              [
                `self.MonacoEnvironment = { baseUrl: '${baseUrl}' };\n` +
                  `importScripts('${vsBase}/base/worker/workerMain.js');`,
              ],
              { type: 'text/javascript' }
            )
          );
          const worker = new Worker(workerUrl);
          URL.revokeObjectURL(workerUrl);
          return worker;
        },
      };
      window.require.config({ paths: { vs: vsBase } });
      window.require(
        ['vs/editor/editor.main'],
        () => {
          try {
            configureMonaco(window.monaco);
            resolve(window.monaco);
          } catch (error) {
            reject(error);
          }
        },
        reject
      );
    };

    if (window.require && typeof window.require.config === 'function') {
      loadEditor();
      return;
    }

    const script = document.createElement('script');
    script.src = `${vsBase}/loader.js`;
    script.onload = () => {
      script.remove();
      loadEditor();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Monaco 加载失败'));
    };
    document.head.appendChild(script);
  });
}

function loadMonaco() {
  if (window.monaco) {
    configureMonaco(window.monaco);
    return Promise.resolve(window.monaco);
  }
  if (monacoPromise) return monacoPromise;

  // 本地 vendor 优先；文件缺失或加载失败时回退 CDN（需联网）。
  const attempt = loadMonacoFrom(MONACO_LOCAL).catch((localError) => {
    if (window.monaco) return window.monaco;
    return loadMonacoFrom(MONACO_CDN).catch((cdnError) => {
      throw cdnError || localError;
    });
  });

  monacoPromise = attempt;
  attempt.catch(() => {
    // 失败不能永久缓存，否则断网恢复后仍无法重试。
    if (monacoPromise === attempt) monacoPromise = null;
  });
  return attempt;
}

// 返回统一接口 { getValue, setValue, setLanguage, setFontSize, setError, clearError, layout, retry, upgrade, dispose }
// setError(line, message)：在某行标红（line 为空则仅清除）；无行号时也可只显示提示
// lazy: true 时不自动加载 Monaco，由调用方在首次聚焦或进入视口时再调 upgrade() 升级
export async function createEditor(container, { language, value, onChange, lazy = false }) {
  let currentLanguage = language;
  let currentFontSize = getEditorFontSize();
  let currentValue = String(value ?? '');
  let currentError = null;
  let disposed = false;
  let upgradePromise = null;
  let backend = null;

  const textarea = document.createElement('textarea');
  textarea.className = 'editor-fallback';
  textarea.value = currentValue;
  textarea.spellcheck = false;
  textarea.style.fontSize = `${currentFontSize}px`;

  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.className = 'btn editor-retry';
  retryButton.textContent = '重试加载编辑器';
  retryButton.hidden = true;
  retryButton.style.position = 'absolute';
  retryButton.style.top = '10px';
  retryButton.style.right = '10px';
  retryButton.style.zIndex = '2';

  const previousPosition = container.style.position;
  const adjustedPosition = getComputedStyle(container).position === 'static';
  if (adjustedPosition) container.style.position = 'relative';

  const emitChange = () => {
    currentValue = textarea.value;
    if (typeof onChange === 'function') onChange(currentValue);
  };
  textarea.addEventListener('input', emitChange);
  textarea.addEventListener('keydown', handleIndentKeydown);
  container.append(textarea, retryButton);

  function restoreContainerPosition() {
    if (adjustedPosition) container.style.position = previousPosition;
  }

  function showRetry(error) {
    if (disposed || backend) return;
    retryButton.disabled = false;
    retryButton.hidden = false;
    retryButton.textContent = '重试加载编辑器';
    retryButton.title = error instanceof Error ? error.message : String(error || 'Monaco 加载失败');
  }

  function applyFallbackError() {
    const line = currentError && currentError.line;
    textarea.style.outline = line ? '2px solid var(--fail)' : '';
    textarea.title = line ? `第 ${line} 行：${currentError.message || ''}` : '';
  }

  function applyMonacoError() {
    if (!backend) return;
    const { monaco, editor, model } = backend;
    const line = currentError && currentError.line;
    if (!line || line < 1 || line > model.getLineCount()) {
      monaco.editor.setModelMarkers(model, 'judge', []);
      return;
    }
    monaco.editor.setModelMarkers(model, 'judge', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: currentError.message || '此行出错',
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: model.getLineMaxColumn(line),
      },
    ]);
    editor.revealLineInCenter(line);
  }

  async function upgrade() {
    if (disposed) return false;
    if (backend) return true;
    if (upgradePromise) return upgradePromise;

    retryButton.disabled = true;
    retryButton.hidden = false;
    retryButton.textContent = '正在加载编辑器…';

    const operation = (async () => {
      let monaco;
      try {
        monaco = await loadMonaco();
      } catch (error) {
        showRetry(error);
        return false;
      }

      // dispose 可能发生在网络请求期间；此时绝不能再创建 model 或编辑器实例。
      if (disposed) return false;

      const mount = document.createElement('div');
      mount.style.width = '100%';
      mount.style.height = '100%';
      let model = null;
      let editor = null;
      let contentDisposable = null;

      try {
        // 读取升级瞬间的 textarea 值，包含加载期间用户的全部输入。
        currentValue = textarea.value;
        container.appendChild(mount);
        model = monaco.editor.createModel(currentValue, currentLanguage);
        editor = monaco.editor.create(mount, {
          model,
          theme: getThemePref() === 'dark' ? 'vs-dark' : 'vs',
          minimap: { enabled: false },
          fontSize: currentFontSize,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          tabSize: 4,
          renderWhitespace: 'none',
        });
        contentDisposable = editor.onDidChangeModelContent(() => {
          currentValue = editor.getValue();
          if (typeof onChange === 'function') onChange(currentValue);
        });
        backend = { monaco, mount, model, editor, contentDisposable };
        applyMonacoError();

        textarea.removeEventListener('input', emitChange);
        textarea.removeEventListener('keydown', handleIndentKeydown);
        retryButton.removeEventListener('click', retry);
        textarea.remove();
        retryButton.remove();
        restoreContainerPosition();
        return true;
      } catch (error) {
        if (backend && backend.mount === mount) backend = null;
        if (contentDisposable) contentDisposable.dispose();
        if (editor) editor.dispose();
        if (model) model.dispose();
        mount.remove();
        showRetry(error);
        return false;
      }
    })();

    upgradePromise = operation;
    operation.finally(() => {
      if (upgradePromise === operation) upgradePromise = null;
    });
    return operation;
  }

  function retry() {
    return upgrade();
  }

  retryButton.addEventListener('click', retry);

  const api = {
    getValue: () => (backend ? backend.editor.getValue() : textarea.value),
    setValue: (nextValue) => {
      currentValue = String(nextValue ?? '');
      if (backend) backend.editor.setValue(currentValue);
      else textarea.value = currentValue;
    },
    setLanguage: (nextLanguage) => {
      currentLanguage = nextLanguage;
      if (backend) backend.monaco.editor.setModelLanguage(backend.model, currentLanguage);
    },
    setFontSize: (size) => {
      if (disposed || !Number.isInteger(size) || size < MIN_EDITOR_FONT_SIZE || size > MAX_EDITOR_FONT_SIZE) return;
      currentFontSize = size;
      textarea.style.fontSize = `${size}px`;
      if (backend) backend.editor.updateOptions({ fontSize: size });
    },
    setError: (line, message) => {
      currentError = line ? { line, message } : null;
      if (backend) applyMonacoError();
      else applyFallbackError();
    },
    clearError: () => {
      currentError = null;
      if (backend) backend.monaco.editor.setModelMarkers(backend.model, 'judge', []);
      else applyFallbackError();
    },
    layout: () => backend?.editor.layout(),
    retry,
    upgrade,
    dispose: () => {
      if (disposed) return;
      disposed = true;

      textarea.removeEventListener('input', emitChange);
      textarea.removeEventListener('keydown', handleIndentKeydown);
      retryButton.removeEventListener('click', retry);
      textarea.remove();
      retryButton.remove();
      restoreContainerPosition();

      if (!backend) return;
      const { monaco, mount, model, editor, contentDisposable } = backend;
      backend = null;
      monaco.editor.setModelMarkers(model, 'judge', []);
      contentDisposable.dispose();
      editor.dispose();
      model.dispose();
      mount.remove();
    },
  };

  // 首次加载在后台进行；接口立即可用，因此调用方可在加载完成前安全 dispose。
  // lazy 模式下跳过预加载，等调用方显式触发 upgrade()。
  if (!lazy) void upgrade();
  return api;
}
