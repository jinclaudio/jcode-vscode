const path = require("node:path");
const { spawn } = require("node:child_process");
const vscode = require("vscode");

const TERMINAL_NAME = "Jcode";
const CHAT_VIEW_ID = "jcode.chatView";
const CHAT_SESSION_KEY = "jcode.chat.sessionId";
const CHAT_MODEL_KEY = "jcode.chat.model";
const CHAT_EFFORT_KEY = "jcode.chat.effort";
const MAX_SELECTION_SNAPSHOTS = 20;
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-free",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gpt-5.6-pro",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "grok-4.6",
  "glm-5.2",
  "kimi-k3",
  "qwen3.6-plus",
  "minimax-m3",
];
const CLIENT_NAME = "jcode-vscode/0.3.0";
const BRIDGE_CONNECT_TIMEOUT_MS = 15000;

let jcodeTerminal;
let lastTextEditor;

// The chat backend talks to the user's jcode through the official TypeScript
// SDK (@1jehuang/jcode-sdk), which dials the `jcode api-bridge` Unix socket.
// The bridge is started automatically (detached) the first time it is needed,
// unless one is already running. Model picker entries come from the daemon's
// live catalog (listModels), and the model and reasoning-effort selectors
// drive setModel / setReasoningEffort on the session.
let sdkPromise;
let clientPromise;
let bridgeProcess;

function getSdk() {
  if (!sdkPromise) {
    sdkPromise = import("@1jehuang/jcode-sdk").catch((error) => {
      sdkPromise = undefined;
      throw new Error(
        `The Jcode TypeScript SDK could not be loaded (${error.message}). ` +
          'Install extension dependencies with "npm install" in the extension folder, then reload the window.',
      );
    });
  }
  return sdkPromise;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Connect to the harness API, starting `jcode api-bridge` when needed. */
async function getJcodeClient() {
  if (!clientPromise) {
    clientPromise = connectWithBridge();
  }
  try {
    const client = await clientPromise;
    return client;
  } catch (error) {
    clientPromise = undefined;
    throw error;
  }
}

async function connectWithBridge() {
  const { JcodeClient } = await getSdk();
  const apiSocket = process.env.JCODE_API_SOCKET;
  try {
    const client = await JcodeClient.connect({ clientName: CLIENT_NAME, socketPath: apiSocket });
    watchClientLiveness(client);
    return client;
  } catch (firstError) {
    if (firstError?.code !== "connect_failed") {
      throw firstError;
    }
    spawnBridge(apiSocket);
    const deadline = Date.now() + BRIDGE_CONNECT_TIMEOUT_MS;
    let lastError = firstError;
    while (Date.now() < deadline) {
      await sleep(300);
      try {
        const client = await JcodeClient.connect({ clientName: CLIENT_NAME, socketPath: apiSocket });
        watchClientLiveness(client);
        return client;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Could not reach the Jcode harness API (${errorMessage(lastError)}). ` +
        "Make sure the Jcode CLI is installed and new enough to support `jcode api-bridge`.",
    );
  }
}

function watchClientLiveness(client) {
  client.on("close", () => {
    clientPromise = undefined;
  });
}

function spawnBridge(apiSocket) {
  if (bridgeProcess && bridgeProcess.exitCode === null && bridgeProcess.signalCode === null) {
    return;
  }
  const config = vscode.workspace.getConfiguration("jcode");
  const executable = config.get("executablePath", "jcode");
  const configuredArguments = config.get("launchArguments", []);
  const args = [...configuredArguments, "--no-update", "api-bridge"];
  if (apiSocket) {
    args.push("--api-socket", apiSocket);
  }
  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    bridgeProcess = child;
  } catch (error) {
    // A missing executable surfaces asynchronously through the poll loop
    // in connectWithBridge, which reports the actionable error.
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  lastTextEditor = vscode.window.activeTextEditor;
  const chatProvider = new JcodeChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("jcode.open", () => chatProvider.focus()),
    vscode.commands.registerCommand("jcode.openTerminal", () => openJcodeTerminal(context)),
    vscode.commands.registerCommand("jcode.askSelection", () =>
      chatProvider.stageCurrentSelection(),
    ),
    vscode.commands.registerCommand("jcode.explainSelection", () =>
      chatProvider.sendWithCurrentSelection(
        "Explain this selected code. Focus on behavior, assumptions, and risks.",
      ),
    ),
    vscode.commands.registerCommand("jcode.fixSelection", () =>
      chatProvider.sendWithCurrentSelection(
        "Fix problems in this selected code. Inspect the repository, edit the real source file, and validate the change.",
      ),
    ),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === jcodeTerminal) {
        jcodeTerminal = undefined;
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        lastTextEditor = editor;
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      lastTextEditor = event.textEditor;
    }),
    chatProvider,
  );

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand("jcode._test.sendChat", (text, includeSelection = true) =>
        chatProvider.sendMessage(text, includeSelection),
      ),
      vscode.commands.registerCommand("jcode._test.newChat", () => chatProvider.newChat()),
      vscode.commands.registerCommand("jcode._test.cancelChat", () => chatProvider.cancel()),
      vscode.commands.registerCommand("jcode._test.setModel", (model) =>
        chatProvider.setSelectedModel(model),
      ),
      vscode.commands.registerCommand("jcode._test.setEffort", (effort) =>
        chatProvider.setSelectedEffort(effort),
      ),
      vscode.commands.registerCommand("jcode._test.captureSelection", () =>
        captureSelectionContext(context, false),
      ),
    );
  }
}

class JcodeChatViewProvider {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.pendingSelection = undefined;
    this.running = false;
    this.cancelRequested = false;
    this.sessionId = undefined;
    this.modelWatcher = undefined;
    this.disposed = false;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getChatHtml(webviewView.webview);

    const messageSubscription = webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "ready":
          await this.restoreChat();
          break;
        case "send":
          await this.sendMessage(message.text, message.includeSelection !== false, undefined, {
            model: message.model,
            effort: message.effort,
          });
          break;
        case "cancel":
          await this.cancel();
          break;
        case "newChat":
          await this.newChat();
          break;
        case "openTerminal":
          openJcodeTerminal(this.context);
          break;
        case "model":
          await this.setSelectedModel(message.model);
          break;
        case "effort":
          await this.setSelectedEffort(message.effort);
          break;
      }
    });

    webviewView.onDidDispose(() => {
      messageSubscription.dispose();
      void this.cancel();
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  async focus() {
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  }

  getModelList() {
    const configured = vscode.workspace.getConfiguration("jcode").get("models", []);
    return Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_MODELS;
  }

  getSelectedModel() {
    const saved = this.context.workspaceState.get(CHAT_MODEL_KEY);
    if (saved) {
      return saved;
    }
    return vscode.workspace.getConfiguration("jcode").get("defaultModel", "");
  }

  getSelectedEffort() {
    const saved = this.context.workspaceState.get(CHAT_EFFORT_KEY);
    if (saved) {
      return saved;
    }
    return vscode.workspace.getConfiguration("jcode").get("defaultEffort", "");
  }

  async setSelectedModel(model) {
    const value = typeof model === "string" ? model.trim() : "";
    await this.context.workspaceState.update(CHAT_MODEL_KEY, value || undefined);
    if (!value) {
      return;
    }
    try {
      const client = await getJcodeClient();
      if (!this.sessionId) {
        await this.ensureSession();
      }
      await client.setModel(this.sessionId, value);
      this.post({ type: "options", model: value });
    } catch (error) {
      this.post({ type: "notice", text: `Could not switch model: ${errorMessage(error)}` });
    }
  }

  async setSelectedEffort(effort) {
    const value = typeof effort === "string" ? effort.trim() : "";
    await this.context.workspaceState.update(CHAT_EFFORT_KEY, value || undefined);
    if (!value) {
      return;
    }
    try {
      const client = await getJcodeClient();
      if (!this.sessionId) {
        await this.ensureSession();
      }
      await client.setReasoningEffort(this.sessionId, value);
      this.post({ type: "options", effort: value });
    } catch (error) {
      this.post({ type: "notice", text: `Could not set reasoning effort: ${errorMessage(error)}` });
    }
  }

  /**
   * Attach to the workspace session, creating it on first use, and apply any
   * saved model / effort defaults when a new session is created. Returns the
   * connected SDK client.
   */
  async ensureSession() {
    const client = await getJcodeClient();
    if (!this.sessionId) {
      const savedId = this.context.workspaceState.get(CHAT_SESSION_KEY);
      if (savedId) {
        try {
          await client.attachSession(savedId);
          this.sessionId = savedId;
        } catch {
          // The session is gone or belongs to another instance; create fresh.
        }
      }
    }
    if (!this.sessionId) {
      const workingDir = getWorkingDirectory(getCurrentTextEditor());
      const session = await client.createSession(workingDir);
      this.sessionId = session.session_id;
      await this.context.workspaceState.update(CHAT_SESSION_KEY, session.session_id);
      await this.applySessionDefaults(client);
    }
    return client;
  }

  async applySessionDefaults(client) {
    const model = this.getSelectedModel();
    if (model) {
      try {
        await client.setModel(this.sessionId, model);
      } catch {
        // The daemon rejects models its catalog does not offer; the picker
        // still shows the saved choice and errors surface on explicit changes.
      }
    }
    const effort = this.getSelectedEffort();
    if (effort) {
      try {
        await client.setReasoningEffort(this.sessionId, effort);
      } catch {
        // Accepted effort levels are per-provider, so a level one provider
        // rejects may be fine on another; keep the saved value.
      }
    }
  }

  async restoreChat() {
    const selection = this.pendingSelection?.label;
    let sessionId;
    let models = [];
    let current;
    let error;
    try {
      const client = await this.ensureSession();
      sessionId = this.sessionId;
      try {
        ({ models, current } = await client.listModels(sessionId));
      } catch {
        models = [];
      }
      this.watchModel(client);
    } catch (caught) {
      error = errorMessage(caught);
    }
    this.post({
      type: "restore",
      sessionId,
      selection,
      models: models.length > 0 ? models : this.getModelList(),
      model: this.getSelectedModel() || current || "",
      effortLevels: EFFORT_LEVELS,
      effort: this.getSelectedEffort(),
      error,
    });
  }

  watchModel(client) {
    if (this.modelWatcher) {
      client.off("model_info", this.modelWatcher);
    }
    this.modelWatcher = (event) => {
      if (event.session_id === this.sessionId && event.model) {
        this.post({ type: "options", model: event.model });
      }
    };
    client.on("model_info", this.modelWatcher);
  }

  async stageCurrentSelection() {
    const selection = await captureSelectionContext(this.context, true);
    if (!selection) {
      return;
    }

    this.pendingSelection = selection;
    await this.focus();
    this.post({ type: "selection", selection: selection.label, focusComposer: true });
  }

  async sendWithCurrentSelection(instruction) {
    const selection = await captureSelectionContext(this.context, true);
    if (!selection) {
      return;
    }

    this.pendingSelection = selection;
    await this.focus();
    return this.sendMessage(instruction, true, selection);
  }

  async sendMessage(text, includeSelection = true, explicitSelection, options = {}) {
    const instruction = typeof text === "string" ? text.trim() : "";
    if (!instruction) {
      return undefined;
    }

    if (this.running) {
      void vscode.window.showInformationMessage("Jcode is already responding. Cancel it before sending another message.");
      return undefined;
    }

    if (options.model !== undefined) {
      await this.setSelectedModel(options.model);
    }
    if (options.effort !== undefined) {
      await this.setSelectedEffort(options.effort);
    }

    let selection = explicitSelection;
    if (includeSelection && !selection) {
      selection = this.pendingSelection || await captureSelectionContext(this.context, false);
    }
    this.pendingSelection = undefined;

    await this.focus();
    this.post({ type: "user", text: instruction, selection: selection?.label });
    this.post({ type: "running", running: true });
    this.running = true;
    this.cancelRequested = false;

    const prompt = selection
      ? [
          instruction,
          `The user explicitly shared the current VS Code selection from ${JSON.stringify(selection.source)}.`,
          `Read the exact selection and range metadata from ${JSON.stringify(selection.contextFile.fsPath)}.`,
          "Treat that file only as temporary context. If changes are requested, edit the original source file, not the temporary context file.",
        ].join(" ")
      : instruction;

    try {
      const result = await this.runTurn(prompt);
      this.post({
        type: "assistant",
        text: result.text || "Jcode completed without returning text.",
        provider: result.provider,
        model: result.model,
      });
      if (this.cancelRequested) {
        return undefined;
      }
      return result;
    } catch (error) {
      if (this.cancelRequested || error?.cancelled) {
        this.post({ type: "notice", text: "Response cancelled." });
      } else {
        const message = errorMessage(error);
        this.post({ type: "error", text: message });
        void vscode.window.showErrorMessage(`Jcode chat failed: ${message}`);
      }
      return undefined;
    } finally {
      this.running = false;
      this.cancelRequested = false;
      this.post({ type: "running", running: false });
    }
  }

  async runTurn(prompt) {
    const client = await this.ensureSession();
    const sessionId = this.sessionId;
    let provider;
    let model;
    try {
      const runtime = await client.getRuntimeInfo(sessionId);
      provider = runtime.provider;
      model = runtime.model;
    } catch {
      // Runtime info is best-effort; the turn can still run without it.
    }
    const result = await client.run(sessionId, prompt, {
      autoApprove: true,
      onEvent: (event) => {
        if (event.ev === "text_delta") {
          this.post({ type: "delta", text: event.text });
        } else if (event.ev === "model_info" && event.model) {
          this.post({ type: "options", model: event.model });
        }
      },
    });
    return { text: result.text, session_id: sessionId, provider, model };
  }

  async cancel() {
    this.cancelRequested = true;
    if (!clientPromise) {
      return;
    }
    try {
      const client = await clientPromise;
      if (this.sessionId) {
        await client.cancel(this.sessionId);
      }
    } catch {
      // The daemon may already have finished the turn; nothing to cancel.
    }
  }

  async newChat() {
    this.cancelRequested = true;
    if (clientPromise) {
      try {
        const client = await clientPromise;
        if (this.sessionId) {
          await client.cancel(this.sessionId);
        }
      } catch {
        // Ignore; a fresh session is created below regardless.
      }
    }
    this.pendingSelection = undefined;
    this.sessionId = undefined;
    await this.context.workspaceState.update(CHAT_SESSION_KEY, undefined);
    this.post({ type: "cleared" });
    try {
      await this.ensureSession();
    } catch (error) {
      this.post({ type: "notice", text: `Could not start a new Jcode session: ${errorMessage(error)}` });
    }
  }

  post(message) {
    void this.view?.webview.postMessage(message);
  }

  dispose() {
    this.disposed = true;
    void this.cancel();
  }
}

async function captureSelectionContext(context, warnWhenMissing) {
  const editor = getCurrentTextEditor();
  if (!editor) {
    if (warnWhenMissing) {
      void vscode.window.showWarningMessage("Open a text editor and select some code first.");
    }
    return undefined;
  }

  const selections = editor.selections.filter((selection) => !selection.isEmpty);
  if (selections.length === 0) {
    if (warnWhenMissing) {
      void vscode.window.showWarningMessage("Select some code first.");
    }
    return undefined;
  }

  const config = vscode.workspace.getConfiguration("jcode");
  const maxCharacters = config.get("maxSelectionCharacters", 200000);
  const selectedText = selections
    .map((selection, index) => {
      const range = formatRange(selection);
      return `## Selection ${index + 1} (${range})\n\n${editor.document.getText(selection)}`;
    })
    .join("\n\n");

  if (selectedText.length > maxCharacters) {
    void vscode.window.showErrorMessage(
      `The selection is ${selectedText.length.toLocaleString()} characters. The configured limit is ${maxCharacters.toLocaleString()}.`,
    );
    return undefined;
  }

  const contextFile = await writeSelectionContext(context, editor, selectedText);
  const source = editor.document.uri.scheme === "file"
    ? editor.document.uri.fsPath
    : editor.document.uri.toString();
  const ranges = selections.map(formatRange).join(", ");
  const fileName = editor.document.uri.scheme === "file"
    ? path.basename(editor.document.uri.fsPath)
    : editor.document.uri.toString();

  return {
    contextFile,
    source,
    label: `${fileName} · ${selections.length} selection${selections.length === 1 ? "" : "s"} · ${ranges}`,
  };
}

function getCurrentTextEditor() {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    lastTextEditor = activeEditor;
    return activeEditor;
  }

  if (lastTextEditor && vscode.workspace.textDocuments.includes(lastTextEditor.document)) {
    return lastTextEditor;
  }
  return undefined;
}

async function writeSelectionContext(context, editor, selectedText) {
  const directory = vscode.Uri.joinPath(context.globalStorageUri, "selections");
  await vscode.workspace.fs.createDirectory(directory);

  const document = editor.document;
  const metadata = [
    "# VS Code selection context",
    "",
    `- Source: ${document.uri.toString()}`,
    `- Language: ${document.languageId}`,
    `- Version: ${document.version}`,
    `- Dirty: ${document.isDirty}`,
    `- Captured: ${new Date().toISOString()}`,
    "",
    selectedText,
    "",
  ].join("\n");

  const file = vscode.Uri.joinPath(
    directory,
    `selection-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  await vscode.workspace.fs.writeFile(file, Buffer.from(metadata, "utf8"));
  await pruneSelectionContexts(directory);
  return file;
}

async function pruneSelectionContexts(directory) {
  const entries = await vscode.workspace.fs.readDirectory(directory);
  const snapshots = entries
    .filter(([name, type]) =>
      type === vscode.FileType.File && name.startsWith("selection-") && name.endsWith(".md"),
    )
    .map(([name]) => name)
    .sort()
    .reverse();

  await Promise.all(
    snapshots.slice(MAX_SELECTION_SNAPSHOTS).map((name) =>
      vscode.workspace.fs.delete(vscode.Uri.joinPath(directory, name), { useTrash: false }),
    ),
  );
}

function openJcodeTerminal(context, editor = getCurrentTextEditor()) {
  if (jcodeTerminal && !jcodeTerminal.exitStatus) {
    jcodeTerminal.show(false);
    return jcodeTerminal;
  }

  const config = vscode.workspace.getConfiguration("jcode");
  const executable = config.get("executablePath", "jcode");
  const configuredArguments = config.get("launchArguments", []);
  const cwd = getWorkingDirectory(editor);
  const args = cwd ? ["-C", cwd, ...configuredArguments] : configuredArguments;

  const model = context.workspaceState.get(CHAT_MODEL_KEY) || config.get("defaultModel", "");
  const hasExplicitModel = args.includes("-m") || args.includes("--model");
  if (model && !hasExplicitModel) {
    args.push("-m", model);
  }

  const env = { ...process.env };
  const effort = context.workspaceState.get(CHAT_EFFORT_KEY) || config.get("defaultEffort", "");
  if (effort) {
    env.JCODE_OPENAI_REASONING_EFFORT = effort;
    env.JCODE_ANTHROPIC_REASONING_EFFORT = effort;
  }

  jcodeTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    shellPath: executable,
    shellArgs: args,
    cwd,
    env,
    iconPath: new vscode.ThemeIcon("sparkle"),
    isTransient: false,
  });
  jcodeTerminal.show(false);
  return jcodeTerminal;
}

function getWorkingDirectory(editor) {
  if (editor?.document.uri.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder.uri.fsPath;
    }
    return path.dirname(editor.document.uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function formatRange(selection) {
  const start = selection.start;
  const end = selection.end;
  return `L${start.line + 1}:C${start.character + 1}-L${end.line + 1}:C${end.character + 1}`;
}

function getChatHtml(webview) {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Jcode Chat</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: 13px/1.45 var(--vscode-font-family);
    }
    button, textarea { font: inherit; }
    button:focus-visible, textarea:focus-visible, input:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .app { display: flex; flex-direction: column; height: 100%; min-width: 220px; }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 38px;
      padding: 5px 8px 5px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }
    .brand { display: flex; align-items: center; gap: 7px; font-weight: 600; }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-testing-iconPassed); }
    .toolbar-actions { display: flex; gap: 2px; }
    .btn {
      border: 0;
      border-radius: 5px;
      min-height: 28px;
      padding: 4px 9px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn:active { transform: translateY(1px); }
    .btn:disabled { cursor: default; opacity: .55; transform: none; }
    .btn-ghost { color: var(--vscode-foreground); background: transparent; }
    .btn-ghost:hover { background: var(--vscode-toolbar-hoverBackground); }
    .btn-square { width: 28px; padding: 0; }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px 12px 20px;
      scroll-padding-bottom: 16px;
    }
    .empty { max-width: 31ch; margin: 18vh auto 0; color: var(--vscode-descriptionForeground); text-align: center; }
    .empty-mark {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      margin: 0 auto 12px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 9px;
      color: var(--vscode-textLink-foreground);
      font-size: 18px;
    }
    .empty strong { display: block; margin-bottom: 4px; color: var(--vscode-foreground); font-size: 14px; }
    .chat { display: flex; flex-direction: column; margin: 0 0 16px; }
    .chat-start { align-items: flex-start; }
    .chat-end { align-items: flex-end; }
    .chat-header { margin: 0 6px 5px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .chat-bubble {
      max-width: min(100%, 72ch);
      padding: 9px 10px;
      border-radius: 9px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .chat-start .chat-bubble { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); }
    .chat-end .chat-bubble { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .chat-footer { margin: 5px 6px 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .notice { margin: 10px 0; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: center; }
    .error { color: var(--vscode-errorForeground); }
    .typing { display: flex; gap: 4px; align-items: center; min-height: 39px; }
    .typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--vscode-descriptionForeground); animation: pulse 1.2s infinite; }
    .typing i:nth-child(2) { animation-delay: .16s; }
    .typing i:nth-child(3) { animation-delay: .32s; }
    @keyframes pulse { 0%, 60%, 100% { opacity: .35; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
    .composer-wrap { padding: 8px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .selection {
      display: none;
      margin: 0 1px 7px;
      padding: 5px 7px;
      border-radius: 5px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .selection.visible { display: block; }
    .composer {
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: 9px;
      background: var(--vscode-input-background);
      overflow: hidden;
    }
    .textarea {
      display: block;
      width: 100%;
      min-height: 66px;
      max-height: 180px;
      resize: none;
      border: 0;
      outline: 0;
      padding: 9px 10px 4px;
      color: var(--vscode-input-foreground);
      background: transparent;
    }
    .textarea::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
    .model-row { display: flex; align-items: center; gap: 6px; padding: 0 6px 6px 9px; }
    .model-input {
      flex: 1;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: 5px;
      padding: 3px 7px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-size: 11px;
    }
    .model-input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
    .effort-select {
      max-width: 116px;
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: 5px;
      padding: 3px 4px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-size: 11px;
    }
    .composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 6px 6px 9px; }
    .context-toggle { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .context-toggle span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .send-actions { display: flex; gap: 4px; }
    #cancel { display: none; }
    body.running #send { display: none; }
    body.running #cancel { display: inline-block; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
  </style>
</head>
<body>
  <main class="app">
    <header class="toolbar">
      <div class="brand"><span class="status-dot" aria-hidden="true"></span><span>Jcode</span></div>
      <div class="toolbar-actions">
        <button id="terminal" class="btn btn-ghost btn-square" title="Open terminal agent" aria-label="Open terminal agent">›_</button>
        <button id="new-chat" class="btn btn-ghost" title="Start a new chat">New</button>
      </div>
    </header>
    <section id="messages" class="messages" aria-live="polite">
      <div id="empty" class="empty">
        <div class="empty-mark" aria-hidden="true">✦</div>
        <strong>Work with Jcode</strong>
        Ask about your project, or select code and press <span id="shortcut">Ctrl+Shift+J</span>.
      </div>
    </section>
    <footer class="composer-wrap">
      <div id="selection" class="selection" title=""></div>
      <div class="composer">
        <textarea id="prompt" class="textarea" rows="3" aria-label="Message Jcode" placeholder="Ask Jcode about this workspace…"></textarea>
        <div class="model-row">
          <input id="model" class="model-input" list="model-suggestions" autocomplete="off" spellcheck="false" placeholder="Model (auto)" aria-label="Model" title="Model. Type any name or pick a suggestion; empty uses Jcode's default.">
          <datalist id="model-suggestions"></datalist>
          <select id="effort" class="effort-select" aria-label="Reasoning effort" title="Reasoning effort. Empty uses Jcode's default; accepted levels depend on the provider."></select>
        </div>
        <div class="composer-footer">
          <label class="context-toggle" title="Attach the current editor selection when available">
            <input id="include-selection" type="checkbox" checked>
            <span>Include selection</span>
          </label>
          <div class="send-actions">
            <button id="cancel" class="btn btn-ghost" type="button">Cancel</button>
            <button id="send" class="btn" type="button">Send</button>
          </div>
        </div>
      </div>
    </footer>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const empty = document.getElementById("empty");
    const prompt = document.getElementById("prompt");
    const selection = document.getElementById("selection");
    const includeSelection = document.getElementById("include-selection");
    const modelInput = document.getElementById("model");
    const modelSuggestions = document.getElementById("model-suggestions");
    const effortSelect = document.getElementById("effort");
    const saved = vscode.getState() || { messages: [] };
    let liveBubble = undefined;

    if (navigator.platform.includes("Mac")) {
      document.getElementById("shortcut").textContent = "Cmd+Shift+J";
    }

    function persist() {
      const items = [...messages.querySelectorAll(".chat[data-role]")].map((item) => ({
        role: item.dataset.role,
        text: item.querySelector(".chat-bubble").textContent,
        meta: item.querySelector(".chat-footer")?.textContent || "",
      }));
      vscode.setState({ messages: items });
    }

    function appendMessage(role, text, meta = "") {
      empty.hidden = true;
      const item = document.createElement("article");
      item.className = "chat " + (role === "user" ? "chat-end" : "chat-start");
      item.dataset.role = role;
      const header = document.createElement("div");
      header.className = "chat-header";
      header.textContent = role === "user" ? "You" : "Jcode";
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      bubble.textContent = text;
      item.append(header, bubble);
      if (meta) {
        const footer = document.createElement("div");
        footer.className = "chat-footer";
        footer.textContent = meta;
        item.append(footer);
      }
      messages.append(item);
      messages.scrollTop = messages.scrollHeight;
      persist();
    }

    function createLiveBubble() {
      empty.hidden = true;
      document.getElementById("typing")?.remove();
      const item = document.createElement("article");
      item.className = "chat chat-start";
      item.dataset.role = "assistant";
      const header = document.createElement("div");
      header.className = "chat-header";
      header.textContent = "Jcode";
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      const footer = document.createElement("div");
      footer.className = "chat-footer";
      item.append(header, bubble, footer);
      messages.append(item);
      messages.scrollTop = messages.scrollHeight;
      return { item, bubble, footer };
    }

    function finalizeLiveBubble(meta = "") {
      if (!liveBubble) return;
      liveBubble.footer.textContent = meta;
      liveBubble = undefined;
      persist();
    }

    function appendNotice(text, isError = false) {
      empty.hidden = true;
      const notice = document.createElement("div");
      notice.className = "notice" + (isError ? " error" : "");
      notice.textContent = text;
      messages.append(notice);
      messages.scrollTop = messages.scrollHeight;
    }

    function setSelection(label) {
      selection.textContent = label || "";
      selection.title = label || "";
      selection.classList.toggle("visible", Boolean(label));
    }

    function populateModelOptions(models) {
      modelSuggestions.replaceChildren();
      for (const name of models) {
        const option = document.createElement("option");
        option.value = name;
        modelSuggestions.append(option);
      }
    }

    function populateEffortOptions(levels) {
      effortSelect.replaceChildren();
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "Effort: auto";
      effortSelect.append(auto);
      for (const level of levels) {
        const option = document.createElement("option");
        option.value = level;
        option.textContent = level;
        effortSelect.append(option);
      }
    }

    function applyOptions(data) {
      populateModelOptions(data.models || []);
      populateEffortOptions(data.effortLevels || []);
      if (data.model !== undefined) modelInput.value = data.model;
      if (data.effort !== undefined) effortSelect.value = data.effort;
    }

    function setRunning(running) {
      document.body.classList.toggle("running", running);
      prompt.disabled = running;
      document.getElementById("new-chat").disabled = running;
      let typing = document.getElementById("typing");
      if (running && !typing) {
        typing = document.createElement("div");
        typing.id = "typing";
        typing.className = "chat chat-start";
        typing.innerHTML = '<div class="chat-header">Jcode</div><div class="chat-bubble typing" aria-label="Jcode is responding"><i></i><i></i><i></i></div>';
        messages.append(typing);
        messages.scrollTop = messages.scrollHeight;
      } else if (!running) {
        typing?.remove();
        finalizeLiveBubble();
      }
    }

    function send() {
      const text = prompt.value.trim();
      if (!text || document.body.classList.contains("running")) return;
      vscode.postMessage({
        type: "send",
        text,
        includeSelection: includeSelection.checked,
        model: modelInput.value.trim(),
        effort: effortSelect.value,
      });
      prompt.value = "";
      prompt.style.height = "auto";
    }

    for (const item of saved.messages || []) {
      appendMessage(item.role, item.text, item.meta);
    }
    empty.hidden = Boolean((saved.messages || []).length);

    prompt.addEventListener("input", () => {
      prompt.style.height = "auto";
      prompt.style.height = Math.min(prompt.scrollHeight, 180) + "px";
    });
    prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    document.getElementById("send").addEventListener("click", send);
    document.getElementById("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
    document.getElementById("new-chat").addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
    document.getElementById("terminal").addEventListener("click", () => vscode.postMessage({ type: "openTerminal" }));

    modelInput.addEventListener("change", () => {
      vscode.postMessage({ type: "model", model: modelInput.value.trim() });
    });
    effortSelect.addEventListener("change", () => {
      vscode.postMessage({ type: "effort", effort: effortSelect.value });
    });

    window.addEventListener("message", ({ data }) => {
      switch (data.type) {
        case "restore":
          setSelection(data.selection);
          applyOptions(data);
          if (data.error) appendNotice(data.error, true);
          break;
        case "selection":
          setSelection(data.selection);
          if (data.focusComposer) prompt.focus();
          break;
        case "options":
          if (data.model !== undefined) modelInput.value = data.model;
          if (data.effort !== undefined) effortSelect.value = data.effort;
          break;
        case "user":
          appendMessage("user", data.text, data.selection || "");
          setSelection("");
          break;
        case "delta":
          if (!liveBubble) liveBubble = createLiveBubble();
          liveBubble.bubble.textContent += data.text;
          messages.scrollTop = messages.scrollHeight;
          break;
        case "assistant":
          if (liveBubble) {
            liveBubble.bubble.textContent = data.text;
            liveBubble.footer.textContent = [data.provider, data.model].filter(Boolean).join(" · ");
            liveBubble = undefined;
            persist();
          } else {
            appendMessage("assistant", data.text, [data.provider, data.model].filter(Boolean).join(" · "));
          }
          break;
        case "notice":
          appendNotice(data.text);
          break;
        case "error":
          appendNotice(data.text, true);
          break;
        case "running":
          setRunning(data.running);
          break;
        case "cleared":
          liveBubble = undefined;
          messages.querySelectorAll(":scope > :not(#empty)").forEach((node) => node.remove());
          empty.hidden = false;
          setSelection("");
          vscode.setState({ messages: [] });
          prompt.focus();
          break;
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

function getNonce() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return value;
}

function deactivate() {
  if (bridgeProcess && bridgeProcess.exitCode === null && bridgeProcess.signalCode === null) {
    try {
      bridgeProcess.kill();
    } catch {
      // Already gone.
    }
    bridgeProcess = undefined;
  }
  if (clientPromise) {
    clientPromise.then((client) => {
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }).catch(() => {});
    clientPromise = undefined;
  }
}

module.exports = { activate, deactivate, JcodeChatViewProvider, captureSelectionContext };
