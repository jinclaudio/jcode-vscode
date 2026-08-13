const path = require("node:path");
const { spawn } = require("node:child_process");
const vscode = require("vscode");

const TERMINAL_NAME = "Jcode";
const CHAT_VIEW_ID = "jcode.chatView";
const CHAT_SESSION_KEY = "jcode.chat.sessionId";
const MAX_SELECTION_SNAPSHOTS = 20;
let jcodeTerminal;
let lastTextEditor;

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
    vscode.commands.registerCommand("jcode.openTerminal", () => openJcodeTerminal()),
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
    this.activeRun = undefined;
    this.disposed = false;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getChatHtml(webviewView.webview);

    const messageSubscription = webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "ready":
          this.post({
            type: "restore",
            sessionId: this.context.workspaceState.get(CHAT_SESSION_KEY),
            selection: this.pendingSelection?.label,
          });
          break;
        case "send":
          await this.sendMessage(message.text, message.includeSelection !== false);
          break;
        case "cancel":
          this.cancel();
          break;
        case "newChat":
          await this.newChat();
          break;
        case "openTerminal":
          openJcodeTerminal();
          break;
      }
    });

    webviewView.onDidDispose(() => {
      messageSubscription.dispose();
      this.cancel();
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  async focus() {
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
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

  async sendMessage(text, includeSelection = true, explicitSelection) {
    const instruction = typeof text === "string" ? text.trim() : "";
    if (!instruction) {
      return undefined;
    }

    if (this.activeRun) {
      void vscode.window.showInformationMessage("Jcode is already responding. Cancel it before sending another message.");
      return undefined;
    }

    let selection = explicitSelection;
    if (includeSelection && !selection) {
      selection = this.pendingSelection || await captureSelectionContext(this.context, false);
    }
    this.pendingSelection = undefined;

    await this.focus();
    this.post({ type: "user", text: instruction, selection: selection?.label });
    this.post({ type: "running", running: true });

    const prompt = selection
      ? [
          instruction,
          `The user explicitly shared the current VS Code selection from ${JSON.stringify(selection.source)}.`,
          `Read the exact selection and range metadata from ${JSON.stringify(selection.contextFile.fsPath)}.`,
          "Treat that file only as temporary context. If changes are requested, edit the original source file, not the temporary context file.",
        ].join(" ")
      : instruction;

    try {
      const result = await this.runJcode(prompt);
      this.post({
        type: "assistant",
        text: result.text || "Jcode completed without returning text.",
        provider: result.provider,
        model: result.model,
      });
      return result;
    } catch (error) {
      if (error?.cancelled) {
        this.post({ type: "notice", text: "Response cancelled." });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.post({ type: "error", text: message });
        void vscode.window.showErrorMessage(`Jcode chat failed: ${message}`);
      }
      return undefined;
    } finally {
      this.post({ type: "running", running: false });
    }
  }

  async runJcode(prompt) {
    const config = vscode.workspace.getConfiguration("jcode");
    const executable = config.get("executablePath", "jcode");
    const configuredArguments = config.get("launchArguments", []);
    const cwd = getWorkingDirectory(getCurrentTextEditor());
    const sessionId = this.context.workspaceState.get(CHAT_SESSION_KEY);
    const args = [];

    if (cwd) {
      args.push("-C", cwd);
    }
    args.push(...configuredArguments, "run", "--json", "--no-update");
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    args.push(prompt);

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.activeRun = child;

      let stdout = "";
      let stderr = "";
      let cancelled = false;
      const outputLimit = 16 * 1024 * 1024;

      const append = (current, chunk) => {
        const next = current + chunk;
        return next.length > outputLimit ? next.slice(-outputLimit) : next;
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = append(stderr, chunk);
      });
      child.on("error", (error) => {
        this.activeRun = undefined;
        reject(error);
      });
      child.on("close", async (code, signal) => {
        this.activeRun = undefined;
        cancelled = signal !== null || code === null;
        if (cancelled) {
          reject(Object.assign(new Error("Jcode response was cancelled."), { cancelled: true }));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `jcode run exited with code ${code}`));
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (!result || typeof result.text !== "string") {
            throw new Error("Jcode returned an unexpected JSON response.");
          }
          if (result.session_id) {
            await this.context.workspaceState.update(CHAT_SESSION_KEY, result.session_id);
          }
          resolve(result);
        } catch (error) {
          reject(new Error(`Could not read Jcode response: ${error.message}`));
        }
      });
    });
  }

  cancel() {
    if (this.activeRun) {
      this.activeRun.kill();
    }
  }

  async newChat() {
    this.cancel();
    this.pendingSelection = undefined;
    await this.context.workspaceState.update(CHAT_SESSION_KEY, undefined);
    this.post({ type: "cleared" });
  }

  post(message) {
    void this.view?.webview.postMessage(message);
  }

  dispose() {
    this.disposed = true;
    this.cancel();
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

function openJcodeTerminal(editor = getCurrentTextEditor()) {
  if (jcodeTerminal && !jcodeTerminal.exitStatus) {
    jcodeTerminal.show(false);
    return jcodeTerminal;
  }

  const config = vscode.workspace.getConfiguration("jcode");
  const executable = config.get("executablePath", "jcode");
  const configuredArguments = config.get("launchArguments", []);
  const cwd = getWorkingDirectory(editor);
  const args = cwd ? ["-C", cwd, ...configuredArguments] : configuredArguments;

  jcodeTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    shellPath: executable,
    shellArgs: args,
    cwd,
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
    const saved = vscode.getState() || { messages: [] };

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
      }
    }

    function send() {
      const text = prompt.value.trim();
      if (!text || document.body.classList.contains("running")) return;
      vscode.postMessage({ type: "send", text, includeSelection: includeSelection.checked });
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

    window.addEventListener("message", ({ data }) => {
      switch (data.type) {
        case "restore":
          setSelection(data.selection);
          break;
        case "selection":
          setSelection(data.selection);
          if (data.focusComposer) prompt.focus();
          break;
        case "user":
          appendMessage("user", data.text, data.selection || "");
          setSelection("");
          break;
        case "assistant":
          appendMessage("assistant", data.text, [data.provider, data.model].filter(Boolean).join(" · "));
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

function deactivate() {}

module.exports = { activate, deactivate, JcodeChatViewProvider, captureSelectionContext };
