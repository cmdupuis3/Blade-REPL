// A minimal, zero-dependency stand-in for the `vscode` module, so
// src/extension.js (and the modules it requires — src/repl.js, src/serve.js)
// can be `require`d and exercised OUTSIDE the VS Code host. Real VS Code
// resolves `require("vscode")` through its own module loader; there is no
// npm package to install in its place. The robust zero-dep trick is to prime
// Node's OWN module loader: patch `Module._load` so any `require("vscode")`
// anywhere in the process (extension.js, and transitively repl.js/serve.js)
// resolves to this mock instead of failing with MODULE_NOT_FOUND.
//
// Scope: enough of the API surface for src/extension.js's providers and
// activate() to run headlessly (scripts/provider-test.js) — not a general
// VS Code emulator. Classes mirror real vscode's shape closely enough that
// code written against the real typings behaves the same way here (Range
// end is exclusive, Position comparisons, etc.), but simplifications are
// taken wherever exact fidelity doesn't matter for a headless unit test
// (e.g. MarkdownString.appendText does not escape markdown here).
//
// Usage:
//   const vscodeMock = require("./vscode-mock");
//   const mock = vscodeMock.install();       // patches Module._load, once
//   const ext = require("../src/extension"); // now sees the mock
//   const doc = vscodeMock.makeDoc("let x = 1\n", "test.blade");

"use strict";

const Module = require("module");

// --- Position / Range / Selection / Location ---------------------------------

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isEqual(other) {
    return this.line === other.line && this.character === other.character;
  }
  isBefore(other) {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isBeforeOrEqual(other) {
    return this.isBefore(other) || this.isEqual(other);
  }
  isAfter(other) {
    return !this.isBeforeOrEqual(other);
  }
  isAfterOrEqual(other) {
    return !this.isBefore(other);
  }
  translate(lineDelta, charDelta) {
    return new Position(this.line + (lineDelta || 0), this.character + (charDelta || 0));
  }
  with(line, character) {
    return new Position(line === undefined ? this.line : line, character === undefined ? this.character : character);
  }
}

class Range {
  // Either (Position, Position) or (startLine, startChar, endLine, endChar).
  constructor(a, b, c, d) {
    if (typeof a === "number") {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
  contains(posOrRange) {
    if (posOrRange instanceof Range) {
      return this.contains(posOrRange.start) && this.contains(posOrRange.end);
    }
    return posOrRange.isAfterOrEqual(this.start) && posOrRange.isBeforeOrEqual(this.end);
  }
}

class Selection extends Range {
  constructor(a, b, c, d) {
    if (typeof a === "number") {
      super(a, b, c, d);
      this.anchor = new Position(a, b);
      this.active = new Position(c, d);
    } else {
      super(a, b);
      this.anchor = a;
      this.active = b;
    }
  }
  get isReversed() {
    return this.anchor.isAfter(this.active);
  }
}

class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.range = rangeOrPosition instanceof Range ? rangeOrPosition : new Range(rangeOrPosition, rangeOrPosition);
  }
}

// --- Uri -----------------------------------------------------------------------

class Uri {
  constructor(scheme, p) {
    this.scheme = scheme;
    this.path = p.replace(/\\/g, "/");
    this.fsPath = p;
  }
  toString() {
    return `${this.scheme}://${this.path}`;
  }
  static file(p) {
    return new Uri("file", p);
  }
  static parse(s) {
    const m = /^([a-zA-Z][\w+.-]*):\/\/(.*)$/.exec(s);
    if (m) return new Uri(m[1], m[2]);
    return new Uri("file", s);
  }
  /** Real vscode's Uri.joinPath (1.45+) — src/plots.js resolves media/ and
   *  media/plotly.min.js through it. Path-only, like the real one. */
  static joinPath(base, ...parts) {
    const joined = [base.path.replace(/\/+$/, "")].concat(parts).join("/");
    return new Uri(base.scheme, joined);
  }
}

// --- Markdown / Hover ------------------------------------------------------------

class MarkdownString {
  constructor(value) {
    this.value = value || "";
    this.isTrusted = false;
  }
  // Real vscode escapes markdown-significant characters here; this mock
  // appends verbatim — headless tests care about content, not escaping.
  appendText(text) {
    this.value += String(text);
    return this;
  }
  appendMarkdown(md) {
    this.value += md;
    return this;
  }
  appendCodeblock(code, lang) {
    this.value += `\n\`\`\`${lang || ""}\n${code}\n\`\`\`\n`;
    return this;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

// --- Completion ------------------------------------------------------------------

const CompletionItemKind = {
  Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5,
  Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11,
  Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17,
  Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22,
  Operator: 23, TypeParameter: 24,
};

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

// --- Code actions / lenses / workspace edits --------------------------------------

const CodeActionKind = {
  QuickFix: "quickfix",
  Refactor: "refactor",
  RefactorRewrite: "refactor.rewrite",
  RefactorExtract: "refactor.extract",
  Source: "source",
};

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
    this.edit = undefined;
    this.diagnostics = undefined;
    this.command = undefined;
    this.isPreferred = undefined;
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
  get isResolved() {
    return !!this.command;
  }
}

class WorkspaceEdit {
  constructor() {
    this._edits = new Map(); // uri.toString() -> [{range, newText}]
  }
  _push(uri, range, newText) {
    const key = uri.toString();
    if (!this._edits.has(key)) this._edits.set(key, []);
    this._edits.get(key).push({ range, newText });
  }
  replace(uri, range, newText) {
    this._push(uri, range, newText);
  }
  insert(uri, position, newText) {
    this._push(uri, new Range(position, position), newText);
  }
  delete(uri, range) {
    this._push(uri, range, "");
  }
  get(uri) {
    return this._edits.get(uri.toString()) || [];
  }
  entries() {
    return Array.from(this._edits.entries());
  }
}

// --- Symbols / outline -------------------------------------------------------------

const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
  Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
  Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
  Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
  Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
};

class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
    this.children = [];
  }
}

// --- Signature help ----------------------------------------------------------------

class ParameterInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
  }
}

class SignatureInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
    this.parameters = [];
  }
}

class SignatureHelp {
  constructor() {
    this.signatures = [];
    this.activeSignature = 0;
    this.activeParameter = 0;
  }
}

// --- Diagnostics ---------------------------------------------------------------------

const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity === undefined ? DiagnosticSeverity.Error : severity;
    this.source = undefined;
    this.code = undefined;
    this.relatedInformation = undefined;
  }
}

// --- Events ------------------------------------------------------------------------

class EventEmitter {
  constructor() {
    this._listeners = [];
  }
  get event() {
    return (listener) => {
      this._listeners.push(listener);
      return {
        dispose: () => {
          this._listeners = this._listeners.filter((l) => l !== listener);
        },
      };
    };
  }
  fire(e) {
    for (const l of this._listeners.slice()) l(e);
  }
  dispose() {
    this._listeners = [];
  }
}

// --- Inlay hints (stubs — not exercised by today's providers) ----------------------

const InlayHintKind = { Type: 1, Parameter: 2 };
class InlayHint {
  constructor(position, label, kind) {
    this.position = position;
    this.label = label;
    this.kind = kind;
  }
}

// --- Misc used by src/repl.js (decorations, terminal) -------------------------------

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
const DecorationRangeBehavior = { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

// --- Notebooks (workstream 5, src/notebook.js) ----------------------------------------

const NotebookCellKind = { Markup: 1, Code: 2 };

class NotebookCellData {
  constructor(kind, value, languageId) {
    this.kind = kind;
    this.value = value;
    this.languageId = languageId;
    this.outputs = [];
    this.metadata = undefined;
    this.executionSummary = undefined;
  }
}

class NotebookData {
  constructor(cells) {
    this.cells = cells || [];
    this.metadata = undefined;
  }
}

/** Mirrors real vscode's {mime, data} shape (data is a byte buffer — Buffer
 *  qualifies as a Uint8Array in Node). Tests read `.mime` and decode `.data`
 *  with `Buffer.from(item.data).toString()` / `JSON.parse(...)`. */
class NotebookCellOutputItem {
  constructor(data, mime) {
    this.data = data;
    this.mime = mime;
  }
  static text(value, mime) {
    return new NotebookCellOutputItem(Buffer.from(String(value), "utf8"), mime || "text/plain");
  }
  static json(value, mime) {
    return new NotebookCellOutputItem(Buffer.from(JSON.stringify(value), "utf8"), mime || "application/json");
  }
  static stdout(value) {
    return new NotebookCellOutputItem(Buffer.from(String(value), "utf8"), "application/vnd.code.notebook.stdout");
  }
  static stderr(value) {
    return new NotebookCellOutputItem(Buffer.from(String(value), "utf8"), "application/vnd.code.notebook.stderr");
  }
  static error(error) {
    const payload = { name: (error && error.name) || "Error", message: (error && error.message) || "", stack: error && error.stack };
    return new NotebookCellOutputItem(Buffer.from(JSON.stringify(payload), "utf8"), "application/vnd.code.notebook.error");
  }
}

class NotebookCellOutput {
  constructor(items, metadata) {
    this.items = items || [];
    this.metadata = metadata;
  }
}

class CancellationTokenSource {
  constructor() {
    this._listeners = [];
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener) => {
        this._listeners.push(listener);
        return { dispose: () => {} };
      },
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    for (const l of this._listeners) l();
  }
  dispose() {
    this._listeners = [];
  }
}

// --- Webview panels (src/plots.js) ------------------------------------------------

/** A recording WebviewPanel. `.webview.html` is a plain property the test
 *  reads back after the panel is built; `._posted` collects every
 *  postMessage payload (what the panel told the webview to render);
 *  `.webview._send(msg)` drives the reverse direction (what the webview's
 *  toolbar would post back); `._revealed` records reveal(column,
 *  preserveFocus) calls. asWebviewUri rewrites to a fake webview origin the
 *  same way the real one does — the PATH survives, which is what CSP/asset
 *  assertions care about. */
function makeWebviewPanel(viewType, title, showOptions, options) {
  const inbound = [];
  const disposeListeners = [];
  const panel = {
    viewType,
    title,
    options: options || {},
    viewColumn: showOptions && showOptions.viewColumn !== undefined ? showOptions.viewColumn : showOptions,
    active: true,
    visible: true,
    _posted: [],
    _revealed: [],
    _disposed: false,
    webview: {
      html: "",
      options: options || {},
      cspSource: "vscode-webview://mock-webview",
      asWebviewUri: (uri) => Uri.parse(`https://mock-webview.vscode-cdn.net${uri.path}`),
      postMessage(msg) {
        panel._posted.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(fn) {
        inbound.push(fn);
        return { dispose: () => {} };
      },
      _send(msg) {
        for (const fn of inbound.slice()) fn(msg);
      },
    },
    reveal(viewColumn, preserveFocus) {
      panel._revealed.push({ viewColumn, preserveFocus });
      panel.visible = true;
    },
    onDidDispose(fn) {
      disposeListeners.push(fn);
      return { dispose: () => {} };
    },
    onDidChangeViewState() {
      return { dispose: () => {} };
    },
    dispose() {
      if (panel._disposed) return;
      panel._disposed = true;
      for (const fn of disposeListeners.slice()) fn();
    },
  };
  return panel;
}

/** A recording NotebookCellExecution: `.start`/`.end`/`.clearOutput`/
 *  `.replaceOutput`/`.appendOutput` all behave like the real Thenable-
 *  returning API, and every replaceOutput/appendOutput call's items land in
 *  `._outputs` (flattened) so a test can assert on exactly what a real
 *  execution would have shown. `._started`/`._ended`/`._success` record the
 *  start(t)/end(success,t) calls. */
function makeNotebookCellExecution(cell, controller) {
  const exec = {
    cell,
    controller,
    executionOrder: undefined,
    token: new CancellationTokenSource().token,
    _outputs: [],
    _started: undefined,
    _ended: undefined,
    _success: undefined,
    start(t) {
      this._started = t === undefined ? Date.now() : t;
    },
    end(success, t) {
      this._success = success;
      this._ended = t === undefined ? Date.now() : t;
    },
    clearOutput() {
      this._outputs = [];
      return Promise.resolve();
    },
    replaceOutput(out) {
      this._outputs = Array.isArray(out) ? out.slice() : [out];
      return Promise.resolve();
    },
    appendOutput(out) {
      this._outputs.push(...(Array.isArray(out) ? out : [out]));
      return Promise.resolve();
    },
  };
  return exec;
}

/** `notebooks.createNotebookController` records every controller it creates
 *  (`notebooks._controllers`) so a test can drive `.executeHandler`/
 *  `.interruptHandler` directly, or just call `.createNotebookCellExecution`
 *  to get a recording execution for output-assembly tests without going
 *  through a real execute handler at all. */
function buildNotebooksNamespace() {
  const notebooks = {
    _controllers: [],
    createNotebookController(id, notebookType, label) {
      const controller = {
        id,
        notebookType,
        label,
        supportedLanguages: undefined,
        supportsExecutionOrder: undefined,
        executeHandler: undefined,
        interruptHandler: undefined,
        description: undefined,
        _executions: [],
        createNotebookCellExecution(cell) {
          const exec = makeNotebookCellExecution(cell, controller);
          controller._executions.push(exec);
          return exec;
        },
        dispose() {},
      };
      notebooks._controllers.push(controller);
      return controller;
    },
  };
  return notebooks;
}

// --- Fake TextDocument ---------------------------------------------------------------

/** A minimal fake vscode.TextDocument over a fixed string — no live editing
 *  (tests that need different content just build a new doc). Covers what
 *  extension.js's providers actually call: getText, lineAt, lineCount,
 *  offsetAt/positionAt, getWordRangeAtPosition, uri, fileName, version,
 *  languageId. */
function makeDoc(text, fileName) {
  const name = fileName || "test.blade";
  const uri = Uri.file(name);
  const lines = text.split(/\r?\n/);
  let version = 1;
  const doc = {
    uri,
    fileName: name,
    languageId: "blade",
    get version() {
      return version;
    },
    set version(v) {
      version = v;
    },
    get lineCount() {
      return lines.length;
    },
    getText(range) {
      if (!range) return text;
      if (range.start.line === range.end.line) {
        return (lines[range.start.line] || "").slice(range.start.character, range.end.character);
      }
      let out = (lines[range.start.line] || "").slice(range.start.character);
      for (let l = range.start.line + 1; l < range.end.line; l++) out += "\n" + (lines[l] || "");
      out += "\n" + (lines[range.end.line] || "").slice(0, range.end.character);
      return out;
    },
    lineAt(lineOrPos) {
      const line = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line;
      const t = lines[line] !== undefined ? lines[line] : "";
      const range = new Range(new Position(line, 0), new Position(line, t.length));
      return {
        lineNumber: line,
        text: t,
        range,
        rangeIncludingLineBreak: range,
        firstNonWhitespaceCharacterIndex: t.length - t.replace(/^\s+/, "").length,
        isEmptyOrWhitespace: t.trim().length === 0,
      };
    },
    offsetAt(position) {
      let offset = 0;
      for (let i = 0; i < position.line; i++) offset += (lines[i] || "").length + 1;
      return offset + position.character;
    },
    positionAt(offset) {
      let remaining = offset;
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) return new Position(i, remaining);
        remaining -= lines[i].length + 1;
      }
      return new Position(lines.length - 1, (lines[lines.length - 1] || "").length);
    },
    getWordRangeAtPosition(position, regex) {
      const src = regex ? regex.source : "[A-Za-z_][A-Za-z0-9_]*";
      const flags = regex && regex.flags.includes("g") ? regex.flags : (regex ? regex.flags : "") + "g";
      const re = new RegExp(src, flags);
      const t = lines[position.line] || "";
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) {
        const start = m.index;
        const end = m.index + m[0].length;
        if (position.character >= start && position.character <= end) {
          return new Range(new Position(position.line, start), new Position(position.line, end));
        }
        if (m[0].length === 0) re.lastIndex++;
      }
      return undefined;
    },
  };
  return doc;
}

// --- Namespaces (workspace / window / languages / commands) ------------------------

function buildMock() {
  const configStore = {}; // "blade.signatureLens.functions" -> value, settable by tests
  function getConfiguration(section) {
    const prefix = section ? section + "." : "";
    return {
      get(key, def) {
        const full = prefix + key;
        return Object.prototype.hasOwnProperty.call(configStore, full) ? configStore[full] : def;
      },
    };
  }

  const appliedEdits = [];
  const notebookSerializers = new Map(); // notebookType -> {serializer, options}
  const workspace = {
    _config: configStore,
    textDocuments: [],
    // Mirrors real vscode.workspace.notebookDocuments — src/notebook.js's
    // findOwningNotebookAndCell (workstream 5 N3) scans this to find which
    // open notebook owns a given cell TextDocument. Empty by default; a test
    // that needs it populated pushes a fake {notebookType, getCells()} onto
    // this array directly (the event registrations below never fire on
    // their own — see the module header — so nothing else keeps it in sync).
    notebookDocuments: [],
    workspaceFolders: undefined,
    getConfiguration,
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidCloseNotebookDocument: () => ({ dispose() {} }),
    onDidOpenNotebookDocument: () => ({ dispose() {} }),
    openTextDocument: (opts) => Promise.resolve(makeDoc((opts && opts.content) || "", "untitled")),
    applyEdit: (edit) => {
      appliedEdits.push(edit);
      return Promise.resolve(true);
    },
    _appliedEdits: appliedEdits,
    registerNotebookSerializer: (notebookType, serializer, options) => {
      notebookSerializers.set(notebookType, { serializer, options });
      return { dispose: () => notebookSerializers.delete(notebookType) };
    },
    _notebookSerializers: notebookSerializers,
    // `content` (a vscode.NotebookData) is what the real API's second
    // overload — openNotebookDocument(notebookType, content?) — opens as an
    // UNTITLED notebook. This mock skips actual untitled-document bookkeeping
    // and just hands back an object shaped enough for src/notebook.js's
    // commands (uri, notebookType, getCells()).
    openNotebookDocument: (notebookType, content) =>
      Promise.resolve({
        uri: Uri.parse(`untitled:${notebookType}-${Date.now()}`),
        notebookType,
        getCells: () => (content ? content.cells : []),
      }),
  };

  const window = {
    activeTextEditor: undefined,
    activeNotebookEditor: undefined,
    visibleTextEditors: [],
    showWarningMessage: () => undefined,
    showErrorMessage: () => undefined,
    createOutputChannel: () => ({
      appendLine() {},
      append() {},
      show() {},
      clear() {},
      dispose() {},
    }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    createTerminal: () => ({ sendText() {}, show() {}, dispose() {}, name: "mock" }),
    showTextDocument: (doc) =>
      Promise.resolve({ document: doc, selection: undefined, revealRange() {}, setDecorations() {} }),
    showNotebookDocument: (doc) => Promise.resolve({ notebook: doc }),
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    _webviewPanels: [],
    createWebviewPanel(viewType, title, showOptions, options) {
      const panel = makeWebviewPanel(viewType, title, showOptions, options);
      window._webviewPanels.push(panel);
      return panel;
    },
  };

  const commandRegistry = new Map();
  const commands = {
    registerCommand(id, fn) {
      commandRegistry.set(id, fn);
      return { dispose: () => commandRegistry.delete(id) };
    },
    executeCommand(id, ...args) {
      const fn = commandRegistry.get(id);
      if (!fn) return Promise.reject(new Error(`no such command: ${id}`));
      return Promise.resolve(fn(...args));
    },
    _registry: commandRegistry,
  };

  function createDiagnosticCollection(name) {
    const store = new Map();
    return {
      name,
      set(uri, diags) {
        store.set(uri.toString(), diags);
      },
      delete(uri) {
        store.delete(uri.toString());
      },
      get(uri) {
        return store.get(uri.toString());
      },
      clear() {
        store.clear();
      },
      dispose() {
        store.clear();
      },
      forEach(fn) {
        for (const [k, v] of store) fn(k, v);
      },
      _store: store,
    };
  }

  const languages = {
    createDiagnosticCollection,
    registerHoverProvider: () => ({ dispose() {} }),
    registerSignatureHelpProvider: () => ({ dispose() {} }),
    registerCompletionItemProvider: () => ({ dispose() {} }),
    registerDefinitionProvider: () => ({ dispose() {} }),
    registerReferenceProvider: () => ({ dispose() {} }),
    registerRenameProvider: () => ({ dispose() {} }),
    registerDocumentSymbolProvider: () => ({ dispose() {} }),
    registerCodeActionsProvider: () => ({ dispose() {} }),
    registerCodeLensProvider: () => ({ dispose() {} }),
  };

  return {
    Position, Range, Selection, Location, Uri, MarkdownString, Hover,
    CompletionItem, CompletionItemKind, CodeAction, CodeActionKind, CodeLens,
    WorkspaceEdit, SymbolKind, DocumentSymbol, SignatureHelp,
    SignatureInformation, ParameterInformation, Diagnostic, DiagnosticSeverity,
    EventEmitter, InlayHint, InlayHintKind, ThemeColor, DecorationRangeBehavior,
    ViewColumn,
    // Notebooks (workstream 5).
    NotebookCellKind, NotebookCellData, NotebookData, NotebookCellOutputItem,
    NotebookCellOutput, CancellationTokenSource,
    workspace, window, commands, languages, notebooks: buildNotebooksNamespace(),
  };
}

// --- Module._load patching ----------------------------------------------------------

let installed = false;
let originalLoad = null;
let mockInstance = null;

/** Patch Module._load so every `require("vscode")` in the process — this
 *  script, extension.js, and transitively repl.js/serve.js — resolves to
 *  the same mock instance. Idempotent: a second call returns the existing
 *  instance rather than re-patching. Call this BEFORE requiring
 *  src/extension.js (or anything that requires it). */
function install() {
  if (installed) return mockInstance;
  mockInstance = buildMock();
  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return mockInstance;
    return originalLoad.apply(this, arguments);
  };
  installed = true;
  return mockInstance;
}

/** Restore the original module loader. Mostly for completeness — test
 *  scripts are one-shot processes, so this is rarely needed. */
function uninstall() {
  if (!installed) return;
  Module._load = originalLoad;
  installed = false;
  mockInstance = null;
}

module.exports = { install, uninstall, makeDoc };
