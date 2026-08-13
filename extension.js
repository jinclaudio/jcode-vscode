const path = require("node:path");
const crypto = require("node:crypto");
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
const CLIENT_NAME = "jcode-vscode/0.5.0";
const BRIDGE_CONNECT_TIMEOUT_MS = 15000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const IMAGE_MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);
const SLASH_COMMANDS = [
  { name: "/help", description: "Show commands available in the VS Code chat" },
  { name: "/model", description: "List or switch models", usage: "/model [name]" },
  { name: "/models", description: "Alias for /model", usage: "/models [name]" },
  { name: "/effort", description: "Show or set reasoning effort", usage: "/effort [level]" },
  { name: "/clear", description: "Clear conversation history" },
  { name: "/compact", description: "Compact the current session context" },
  { name: "/rename", description: "Rename the current session", usage: "/rename <title>" },
  { name: "/info", description: "Show session, provider, model, and runtime info" },
  { name: "/cancel", description: "Cancel the current response" },
];

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
let currentClient;
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

function cancelledError() {
  const error = new Error("Response cancelled.");
  error.cancelled = true;
  return error;
}

/** Connect to the harness API, starting `jcode api-bridge` when needed. */
async function getJcodeClient() {
  if (!clientPromise) {
    clientPromise = connectWithBridge();
  }
  try {
    const client = await clientPromise;
    currentClient = client;
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
      if (!bridgeProcess || bridgeProcess.exitCode !== null || bridgeProcess.signalCode !== null) {
        spawnBridge(apiSocket);
      }
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
  currentClient = client;
  client.on("close", () => {
    if (currentClient === client) {
      currentClient = undefined;
      clientPromise = undefined;
    }
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
    child.on("error", () => {
      if (bridgeProcess === child) bridgeProcess = undefined;
    });
    child.on("exit", () => {
      if (bridgeProcess === child) bridgeProcess = undefined;
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
      vscode.commands.registerCommand("jcode._test.sendChat", (text, includeSelection = true, options = {}) =>
        chatProvider.sendMessage(text, includeSelection, undefined, options),
      ),
      vscode.commands.registerCommand("jcode._test.addPastedImage", (mediaType, data, name) =>
        chatProvider.addPastedImage({ mediaType, data, name }),
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
      vscode.commands.registerCommand("jcode._test.getChatState", () => ({
        running: chatProvider.running,
        sessionId: chatProvider.sessionId,
        model: chatProvider.getSelectedModel(),
        effort: chatProvider.getSelectedEffort(),
        attachmentCount: chatProvider.attachments.size,
      })),
      vscode.commands.registerCommand("jcode._test.closeClient", async () => {
        if (currentClient) await currentClient.close();
      }),
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
    this.sessionClient = undefined;
    this.sessionInitPromise = undefined;
    this.modelWatcher = undefined;
    this.modelWatcherClient = undefined;
    this.disposed = false;
    this.nextTurnId = 1;
    this.activeTurnId = undefined;
    this.attachments = new Map();
    this.nextAttachmentId = 1;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getChatHtml(webviewView.webview);

    const messageSubscription = webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "ready":
          if (!message.hasHistory && !this.sessionId) {
            await this.context.workspaceState.update(CHAT_SESSION_KEY, undefined);
          }
          this.postBootstrap();
          void this.restoreChat();
          break;
        case "send":
          await this.sendMessage(message.text, message.includeSelection !== false, undefined, {
            model: message.model,
            effort: message.effort,
            attachmentIds: message.attachmentIds,
          });
          break;
        case "chooseAttachments":
          await this.chooseAttachments();
          break;
        case "addPastedImage":
          await this.addPastedImage(message);
          break;
        case "removeAttachment":
          this.removeAttachment(message.id);
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

  postBootstrap() {
    this.post({
      type: "bootstrap",
      selection: this.pendingSelection?.label,
      models: this.getModelList(),
      model: this.getSelectedModel(),
      effortLevels: EFFORT_LEVELS,
      effort: this.getSelectedEffort(),
      slashCommands: SLASH_COMMANDS,
      attachments: [...this.attachments.values()].map(publicAttachment),
    });
  }

  async setSelectedModel(model, allowWhileRunning = false) {
    const value = typeof model === "string" ? model.trim() : "";
    const previous = this.getSelectedModel();
    if (this.running && !allowWhileRunning) {
      this.post({ type: "notice", text: "Cancel the active response before changing models." });
      this.post({ type: "options", model: previous });
      return false;
    }
    if (!value) {
      await this.context.workspaceState.update(CHAT_MODEL_KEY, undefined);
      this.post({ type: "options", model: previous });
      this.post({ type: "notice", text: "Automatic model selection applies to the next new chat." });
      return true;
    }
    try {
      const client = await this.ensureSession();
      await client.setModel(this.sessionId, value);
      await this.context.workspaceState.update(CHAT_MODEL_KEY, value);
      this.post({ type: "options", model: value });
      return true;
    } catch (error) {
      this.post({ type: "options", model: previous });
      this.post({ type: "error", text: `Could not switch model: ${errorMessage(error)}` });
      return false;
    }
  }

  async setSelectedEffort(effort, allowWhileRunning = false) {
    const value = typeof effort === "string" ? effort.trim() : "";
    const previous = this.getSelectedEffort();
    if (this.running && !allowWhileRunning) {
      this.post({ type: "notice", text: "Cancel the active response before changing reasoning effort." });
      this.post({ type: "options", effort: previous });
      return false;
    }
    if (!value) {
      await this.context.workspaceState.update(CHAT_EFFORT_KEY, undefined);
      this.post({ type: "options", effort: "" });
      this.post({ type: "notice", text: "Automatic reasoning effort applies to the next new chat." });
      return true;
    }
    try {
      const client = await this.ensureSession();
      await client.setReasoningEffort(this.sessionId, value);
      await this.context.workspaceState.update(CHAT_EFFORT_KEY, value);
      this.post({ type: "options", effort: value });
      return true;
    } catch (error) {
      this.post({ type: "options", effort: previous });
      this.post({ type: "error", text: `Could not set reasoning effort: ${errorMessage(error)}` });
      return false;
    }
  }

  /**
   * Attach to the workspace session, creating it on first use, and apply any
   * saved model / effort defaults when a new session is created. Returns the
   * connected SDK client.
   */
  async ensureSession() {
    const client = await getJcodeClient();
    if (this.sessionId && this.sessionClient === client) {
      return client;
    }
    if (!this.sessionInitPromise) {
      this.sessionInitPromise = this.initializeSession(client).finally(() => {
        this.sessionInitPromise = undefined;
      });
    }
    await this.sessionInitPromise;
    if (this.sessionClient !== client) {
      return this.ensureSession();
    }
    return client;
  }

  async initializeSession(client) {
    const candidateId = this.sessionId || this.context.workspaceState.get(CHAT_SESSION_KEY);
    if (candidateId && this.sessionClient !== client) {
      try {
        await client.attachSession(candidateId);
        this.sessionId = candidateId;
        this.sessionClient = client;
      } catch {
        if (this.sessionId === candidateId) this.sessionId = undefined;
        await this.context.workspaceState.update(CHAT_SESSION_KEY, undefined);
      }
    }
    if (!this.sessionId) {
      const savedId = this.context.workspaceState.get(CHAT_SESSION_KEY);
      if (savedId && savedId !== candidateId) {
        try {
          await client.attachSession(savedId);
          this.sessionId = savedId;
          this.sessionClient = client;
        } catch {
          // The session is gone or belongs to another instance; create fresh.
        }
      }
    }
    if (!this.sessionId) {
      const workingDir = getWorkingDirectory(getCurrentTextEditor());
      const session = await client.createSession(workingDir);
      this.sessionId = session.session_id;
      this.sessionClient = client;
      await this.context.workspaceState.update(CHAT_SESSION_KEY, session.session_id);
      await this.applySessionDefaults(client);
    }
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
      model: current || this.getSelectedModel() || "",
      effortLevels: EFFORT_LEVELS,
      effort: this.getSelectedEffort(),
      slashCommands: SLASH_COMMANDS,
      attachments: [...this.attachments.values()].map(publicAttachment),
      error,
    });
  }

  async chooseAttachments() {
    const remaining = MAX_ATTACHMENTS - this.attachments.size;
    if (remaining <= 0) {
      this.post({ type: "notice", text: `You can attach up to ${MAX_ATTACHMENTS} files.` });
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach to Jcode",
    });
    if (!uris) return;
    for (const uri of uris.slice(0, remaining)) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_ATTACHMENT_BYTES) {
          this.post({ type: "notice", text: `${path.basename(uri.fsPath)} is larger than 20 MB and was not attached.` });
          continue;
        }
        const extension = path.extname(uri.fsPath).toLowerCase();
        const attachment = {
          id: `file-${this.nextAttachmentId++}`,
          name: path.basename(uri.fsPath),
          size: stat.size,
          kind: IMAGE_MEDIA_TYPES.has(extension) ? "image" : "file",
          mediaType: IMAGE_MEDIA_TYPES.get(extension),
          uri,
        };
        this.attachments.set(attachment.id, attachment);
      } catch (error) {
        this.post({ type: "notice", text: `Could not attach ${path.basename(uri.fsPath)}: ${errorMessage(error)}` });
      }
    }
    this.post({ type: "attachments", attachments: [...this.attachments.values()].map(publicAttachment) });
  }

  async addPastedImage(message) {
    if (this.attachments.size >= MAX_ATTACHMENTS) return;
    const mediaType = typeof message.mediaType === "string" ? message.mediaType : "";
    const data = typeof message.data === "string" ? message.data : "";
    if (!mediaType.startsWith("image/") || !data || Buffer.byteLength(data, "base64") > MAX_ATTACHMENT_BYTES) {
      this.post({ type: "notice", text: "The pasted image could not be attached or exceeds 20 MB." });
      return;
    }
    const attachment = {
      id: `paste-${this.nextAttachmentId++}`,
      name: typeof message.name === "string" && message.name ? message.name : "Pasted image",
      size: Buffer.byteLength(data, "base64"),
      kind: "image",
      mediaType,
      data,
    };
    this.attachments.set(attachment.id, attachment);
    this.post({ type: "attachments", attachments: [...this.attachments.values()].map(publicAttachment) });
    return attachment.id;
  }

  removeAttachment(id) {
    if (typeof id === "string") this.attachments.delete(id);
    this.post({ type: "attachments", attachments: [...this.attachments.values()].map(publicAttachment) });
  }

  watchModel(client) {
    if (this.modelWatcher && this.modelWatcherClient) {
      this.modelWatcherClient.off("model_info", this.modelWatcher);
    }
    this.modelWatcher = (event) => {
      if (event.session_id === this.sessionId && event.model) {
        void this.context.workspaceState.update(CHAT_MODEL_KEY, event.model);
        this.post({ type: "options", model: event.model });
      }
    };
    client.on("model_info", this.modelWatcher);
    this.modelWatcherClient = client;
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
    let instruction = typeof text === "string" ? text.trim() : "";
    if (!instruction) {
      this.post({ type: "sendRejected", text: typeof text === "string" ? text : "" });
      return undefined;
    }

    const literalSlash = instruction.startsWith("//");
    if (literalSlash) {
      instruction = instruction.slice(1);
    } else if (instruction.startsWith("/")) {
      const commandName = instruction.split(/\s+/, 1)[0];
      if (this.running && commandName !== "/cancel") {
        void vscode.window.showInformationMessage("Jcode is already responding. Use /cancel before another command.");
        this.post({ type: "sendRejected", text: instruction });
        return undefined;
      }
      if (await this.executeSlashCommand(instruction)) {
        this.post({ type: "sendHandled" });
        return undefined;
      }
      this.post({
        type: "error",
        text: `The command ${JSON.stringify(commandName)} is not available in the sidebar yet. Prefix the message with // to send a literal leading slash, or open the terminal agent for the full Jcode command surface.`,
      });
      this.post({ type: "sendRejected", text: instruction });
      return undefined;
    }

    if (this.running) {
      void vscode.window.showInformationMessage("Jcode is already responding. Cancel it before sending another message.");
      this.post({ type: "sendRejected", text: instruction });
      return undefined;
    }

    const turnId = this.nextTurnId++;
    this.activeTurnId = turnId;
    this.running = true;
    this.cancelRequested = false;
    this.post({ type: "running", running: true, turnId });
    let attachments;
    let submitted = false;
    try {
      if (options.model !== undefined) {
        const model = typeof options.model === "string" ? options.model.trim() : "";
        if (model && model !== this.getSelectedModel() && !(await this.setSelectedModel(model, true))) {
          throw new Error("The selected model could not be applied.");
        }
      }
      if (options.effort !== undefined) {
        const effort = typeof options.effort === "string" ? options.effort.trim() : "";
        if (effort && effort !== this.getSelectedEffort() && !(await this.setSelectedEffort(effort, true))) {
          throw new Error("The selected reasoning effort could not be applied.");
        }
      }
      if (!this.isTurnActive(turnId)) throw cancelledError();

      let selection = explicitSelection;
      if (includeSelection && !selection) {
        selection = this.pendingSelection || await captureSelectionContext(this.context, false);
      }
      this.pendingSelection = undefined;
      attachments = await this.consumeAttachments(options.attachmentIds);
      if (!this.isTurnActive(turnId)) throw cancelledError();

      await this.focus();
      if (!this.isTurnActive(turnId)) throw cancelledError();
      this.post({ type: "user", text: instruction, selection: selection?.label, attachments: attachments.public, turnId });
      this.post({ type: "sendAccepted", turnId });
      submitted = true;

      const contextParts = [instruction];
      if (selection) {
        contextParts.push(
          `The user explicitly shared the current VS Code selection from ${JSON.stringify(selection.source)}.`,
          `Read the exact selection and range metadata from ${JSON.stringify(selection.contextFile.fsPath)}.`,
          "Treat that file only as temporary context. If changes are requested, edit the original source file, not the temporary context file.",
        );
      }
      if (attachments.files.length) {
        contextParts.push(
          `The user attached these files: ${attachments.files.map((file) => JSON.stringify(file)).join(", ")}. Read them directly when relevant.`,
        );
      }
      const result = await this.runTurn(contextParts.join(" "), attachments.images, turnId, attachments);
      if (!this.isTurnActive(turnId)) return undefined;
      this.post({
        type: "assistant",
        text: result.text || "Jcode completed without returning text.",
        provider: result.provider,
        model: result.model,
        turnId,
      });
      return result;
    } catch (error) {
      if (attachments?.selected?.length && !attachments.accepted) {
        for (const attachment of attachments.selected) this.attachments.set(attachment.id, attachment);
        this.post({ type: "attachments", attachments: [...this.attachments.values()].map(publicAttachment) });
      }
      if (this.cancelRequested || error?.cancelled || !this.isTurnActive(turnId)) {
        if (submitted) this.post({ type: "notice", text: "Response cancelled.", turnId });
        else this.post({ type: "sendRejected", text: instruction, turnId });
      } else {
        const message = errorMessage(error);
        this.post({ type: "error", text: message, turnId });
        this.post({ type: "sendRejected", text: instruction, turnId });
        void vscode.window.showErrorMessage(`Jcode chat failed: ${message}`);
      }
      return undefined;
    } finally {
      if (this.activeTurnId === turnId) {
        this.running = false;
        this.cancelRequested = false;
        this.activeTurnId = undefined;
        this.post({ type: "running", running: false, turnId });
      }
    }
  }

  isTurnActive(turnId) {
    return this.activeTurnId === turnId && !this.cancelRequested && !this.disposed;
  }

  async consumeAttachments(ids) {
    const requested = Array.isArray(ids) ? ids : [];
    const selected = requested.map((id) => this.attachments.get(id)).filter(Boolean);
    const images = [];
    const files = [];
    for (const attachment of selected) {
      if (attachment.kind === "image") {
        const data = attachment.data || Buffer.from(await vscode.workspace.fs.readFile(attachment.uri)).toString("base64");
        images.push([attachment.mediaType, data]);
      } else if (attachment.uri) {
        files.push(attachment.uri.fsPath);
      }
    }
    for (const attachment of selected) {
      this.attachments.delete(attachment.id);
    }
    this.post({ type: "attachments", attachments: [...this.attachments.values()].map(publicAttachment) });
    return { images, files, public: selected.map(publicAttachment), selected, accepted: false };
  }

  async executeSlashCommand(input) {
    const [rawName, ...rest] = input.split(/\s+/);
    const name = rawName === "/models" ? "/model" : rawName;
    const argument = rest.join(" ").trim();
    if (!SLASH_COMMANDS.some((command) => command.name === rawName)) return false;
    if (name === "/cancel") {
      await this.cancel();
      this.post({ type: "notice", text: "Cancel requested." });
      return true;
    }
    if (name === "/help") {
      this.post({ type: "commandHelp", commands: SLASH_COMMANDS });
      return true;
    }
    if (name === "/model") {
      if (!argument) {
        try {
          const client = await this.ensureSession();
          const catalog = await client.listModels(this.sessionId);
          this.post({
            type: "commandInfo",
            title: "Available models",
            rows: catalog.models.map((model) => [model === catalog.current ? "current" : "model", model]),
          });
          this.post({ type: "openModelPicker" });
        } catch (error) {
          this.post({ type: "error", text: `/model failed: ${errorMessage(error)}` });
        }
      } else await this.setSelectedModel(argument);
      return true;
    }
    if (name === "/effort") {
      if (!argument) this.post({ type: "openEffortPicker" });
      else if (EFFORT_LEVELS.includes(argument)) await this.setSelectedEffort(argument);
      else this.post({ type: "error", text: `Unknown effort ${JSON.stringify(argument)}. Use: ${EFFORT_LEVELS.join(", ")}.` });
      return true;
    }
    try {
      const client = await this.ensureSession();
      if (name === "/clear") {
        await client.clear(this.sessionId);
        this.attachments.clear();
        this.post({ type: "cleared" });
        this.post({ type: "notice", text: "Conversation history cleared." });
      } else if (name === "/compact") {
        await client.compact(this.sessionId);
        this.post({ type: "notice", text: "Context compaction scheduled." });
      } else if (name === "/rename") {
        if (!argument) this.post({ type: "error", text: "Usage: /rename <title>" });
        else {
          await client.renameSession(this.sessionId, argument);
          this.post({ type: "notice", text: `Session renamed to ${argument}.` });
        }
      } else if (name === "/info") {
        const runtime = await client.getRuntimeInfo(this.sessionId);
        this.post({
          type: "commandInfo",
          title: "Session info",
          rows: [
            ["Session", this.sessionId],
            ["Provider", runtime.provider || "auto"],
            ["Model", runtime.model || this.getSelectedModel() || "auto"],
            ["Server", runtime.server || "Jcode"],
          ],
        });
      }
    } catch (error) {
      this.post({ type: "error", text: `${name} failed: ${errorMessage(error)}` });
    }
    return true;
  }

  async runTurn(prompt, images = [], turnId, attachmentState) {
    const client = await this.ensureSession();
    if (!this.isTurnActive(turnId)) {
      throw cancelledError();
    }
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
    if (!this.isTurnActive(turnId)) {
      throw cancelledError();
    }
    if (attachmentState) attachmentState.accepted = true;
    const result = await client.run(sessionId, prompt, {
      images,
      autoApprove: true,
      onEvent: (event) => {
        if (!this.isTurnActive(turnId)) return;
        if (event.ev === "text_delta") {
          this.post({ type: "delta", text: event.text, turnId, sessionId });
        } else if (event.ev === "model_info" && event.model) {
          this.post({ type: "options", model: event.model });
        }
      },
    });
    return { text: result.text, session_id: sessionId, provider, model };
  }

  async cancel() {
    this.cancelRequested = true;
    const cancelledTurnId = this.activeTurnId;
    if (!clientPromise) {
      this.activeTurnId = undefined;
      this.running = false;
      this.post({ type: "running", running: false, turnId: cancelledTurnId });
      return;
    }
    try {
      const client = await clientPromise;
      if (this.sessionId) {
        await client.cancel(this.sessionId);
      }
    } catch {
      // The daemon may already have finished the turn; nothing to cancel.
    } finally {
      if (this.activeTurnId === cancelledTurnId) {
        this.activeTurnId = undefined;
        this.running = false;
        this.post({ type: "running", running: false, turnId: cancelledTurnId });
      }
    }
  }

  async newChat() {
    await this.cancel();
    if (this.sessionInitPromise) {
      try {
        await this.sessionInitPromise;
      } catch {
        // A failed initialization should not prevent creating a fresh session.
      }
    }
    this.pendingSelection = undefined;
    this.attachments.clear();
    this.sessionId = undefined;
    this.sessionClient = undefined;
    await this.context.workspaceState.update(CHAT_SESSION_KEY, undefined);
    this.post({ type: "cleared" });
    this.post({ type: "options", model: this.getSelectedModel(), effort: this.getSelectedEffort() });
  }

  post(message) {
    void this.view?.webview.postMessage(message);
  }

  dispose() {
    this.disposed = true;
    if (this.modelWatcher && this.modelWatcherClient) {
      this.modelWatcherClient.off("model_info", this.modelWatcher);
      this.modelWatcher = undefined;
      this.modelWatcherClient = undefined;
    }
    void this.cancel();
  }
}

function publicAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    kind: attachment.kind,
  };
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
    :root { color-scheme: light dark; --accent: #d97757; --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent); }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 13px/1.5 var(--vscode-font-family); }
    button, textarea, input, select { font: inherit; }
    button, input, select, textarea { color: inherit; }
    button:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .app { display: flex; flex-direction: column; height: 100%; min-width: 230px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; min-height: 42px; padding: 7px 8px 7px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    .brand { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 600; }
    .brand-mark { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; color: #fff; background: var(--accent); font-weight: 700; font-size: 12px; }
    .brand-copy { display: flex; flex-direction: column; min-width: 0; line-height: 1.1; }
    .brand-copy small { color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 400; }
    .top-actions { display: flex; gap: 2px; }
    .icon-btn { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .messages { flex: 1; overflow-y: auto; padding: 14px 12px 24px; scroll-padding-bottom: 24px; }
    .welcome { max-width: 420px; margin: max(38px, 10vh) auto 0; }
    .welcome-mark { display: grid; place-items: center; width: 36px; height: 36px; margin-bottom: 15px; border-radius: 10px; color: #fff; background: var(--accent); font-size: 19px; }
    .welcome h1 { margin: 0 0 6px; font-size: 19px; line-height: 1.25; font-weight: 600; letter-spacing: -.2px; }
    .welcome p { margin: 0 0 18px; color: var(--vscode-descriptionForeground); }
    .starters { display: grid; gap: 7px; }
    .starter { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 9px; color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-editorWidget-background) 58%, transparent); text-align: left; cursor: pointer; }
    .starter:hover { border-color: color-mix(in srgb, var(--accent) 48%, var(--vscode-widget-border)); background: var(--accent-soft); }
    .starter-icon { color: var(--accent); font-size: 15px; }
    .chat { margin: 0 auto 18px; max-width: 760px; }
    .chat-header { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 500; }
    .avatar { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; color: #fff; background: var(--accent); font-size: 10px; font-weight: 700; }
    .chat-user .avatar { color: var(--vscode-foreground); background: var(--vscode-badge-background); }
    .chat-bubble { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
    .chat-user .chat-bubble { padding: 10px 11px; border: 1px solid var(--vscode-widget-border); border-radius: 10px; background: color-mix(in srgb, var(--vscode-editorWidget-background) 78%, transparent); }
    .chat-assistant .chat-bubble { padding: 1px 2px; }
    .chat-footer { margin-top: 7px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .message-attachments { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 7px; }
    .message-file { display: inline-flex; align-items: center; gap: 5px; max-width: 210px; padding: 4px 7px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background); font-size: 10px; }
    .message-file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .notice { max-width: 680px; margin: 12px auto; padding: 7px 9px; border-radius: 7px; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-editorWidget-background) 65%, transparent); font-size: 11px; text-align: center; }
    .notice.error { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 60%, transparent); }
    .command-card { max-width: 680px; margin: 12px auto; overflow: hidden; border: 1px solid var(--vscode-widget-border); border-radius: 9px; background: var(--vscode-editorWidget-background); }
    .command-title { padding: 8px 10px; border-bottom: 1px solid var(--vscode-widget-border); font-weight: 600; }
    .command-row { display: grid; grid-template-columns: minmax(74px, auto) 1fr; gap: 10px; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 55%, transparent); font-size: 11px; }
    .command-row:last-child { border-bottom: 0; }
    .command-row code { color: var(--accent); font-family: var(--vscode-editor-font-family); }
    .command-row span:last-child { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .typing { display: inline-flex; gap: 4px; align-items: center; min-height: 24px; }
    .typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s infinite; }
    .typing i:nth-child(2) { animation-delay: .16s; }
    .typing i:nth-child(3) { animation-delay: .32s; }
    @keyframes pulse { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
    .composer-zone { position: relative; padding: 0 8px 9px; background: linear-gradient(transparent, var(--vscode-sideBar-background) 14px); }
    .selection-chip { display: none; align-items: center; gap: 6px; max-width: 100%; margin: 0 4px 6px; padding: 4px 8px; border-radius: 6px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-inactiveSelectionBackground); font-size: 10px; }
    .selection-chip.visible { display: flex; }
    .selection-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .composer { position: relative; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 12px; background: var(--vscode-input-background); box-shadow: 0 4px 18px rgba(0,0,0,.10); }
    .composer:focus-within { border-color: color-mix(in srgb, var(--accent) 62%, var(--vscode-focusBorder)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent), 0 5px 22px rgba(0,0,0,.14); }
    .pending-attachments { display: none; flex-wrap: wrap; gap: 6px; padding: 8px 8px 0; }
    .pending-attachments.visible { display: flex; }
    .attachment-chip { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 190px; padding: 5px 6px 5px 8px; border: 1px solid var(--vscode-widget-border); border-radius: 7px; background: var(--vscode-editorWidget-background); font-size: 10px; }
    .attachment-chip .attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attachment-chip .attachment-kind { color: var(--accent); }
    .attachment-remove { display: grid; place-items: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 4px; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; }
    .attachment-remove:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .prompt { display: block; width: 100%; min-height: 62px; max-height: 200px; resize: none; border: 0; outline: 0; padding: 10px 11px 4px; color: var(--vscode-input-foreground); background: transparent; line-height: 1.45; }
    .prompt::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
    .composer-tools { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 6px 6px; }
    .tool-left, .tool-right { display: flex; align-items: center; gap: 3px; min-width: 0; }
    .small-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; padding: 0 7px; border: 0; border-radius: 6px; color: var(--vscode-descriptionForeground); background: transparent; font-size: 10px; cursor: pointer; }
    .small-btn:hover, .small-btn.active { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .small-btn.active { color: var(--accent); }
    .small-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .model-input, .effort-select { height: 26px; border: 0; border-radius: 6px; color: var(--vscode-descriptionForeground); background: transparent; font-size: 10px; }
    .model-input { width: min(128px, 34vw); padding: 0 7px; }
    .model-input:hover, .model-input:focus, .effort-select:hover, .effort-select:focus { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); outline: 0; }
    .effort-select { max-width: 82px; padding: 0 3px; }
    .send-btn { display: grid; place-items: center; width: 27px; height: 27px; padding: 0; border: 0; border-radius: 7px; color: #fff; background: var(--accent); cursor: pointer; }
    .send-btn:hover { filter: brightness(1.08); }
    .send-btn:disabled { opacity: .45; cursor: default; }
    .send-btn svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    #cancel { display: none; background: var(--vscode-errorForeground); }
    body.running #send { display: none; }
    body.running #cancel { display: grid; }
    .slash-menu { display: none; position: absolute; left: 12px; right: 12px; bottom: calc(100% - 4px); z-index: 10; max-height: min(320px, 48vh); overflow-y: auto; padding: 5px; border: 1px solid var(--vscode-widget-border); border-radius: 10px; background: var(--vscode-editorWidget-background); box-shadow: 0 8px 30px rgba(0,0,0,.28); }
    .slash-menu.visible { display: block; }
    .slash-item { display: grid; grid-template-columns: minmax(76px, auto) 1fr; gap: 10px; width: 100%; padding: 7px 8px; border: 0; border-radius: 6px; color: var(--vscode-foreground); background: transparent; text-align: left; cursor: pointer; }
    .slash-item:hover, .slash-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .slash-item code { font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: 600; }
    .slash-item span { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .slash-item.selected span { color: inherit; opacity: .8; }
    .composer-hint { margin: 5px 4px 0; color: var(--vscode-descriptionForeground); font-size: 9px; text-align: center; }
    @media (max-width: 300px) { .model-input { width: 80px; } .small-btn span { display: none; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
  </style>
</head>
<body>
  <main class="app">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">J</span><span class="brand-copy"><span>Jcode</span><small id="session-status">Connecting…</small></span></div>
      <div class="top-actions">
        <button id="terminal" class="icon-btn" title="Open terminal agent" aria-label="Open terminal agent"><svg viewBox="0 0 24 24"><path d="m5 7 4 4-4 4M11 17h7"/></svg></button>
        <button id="new-chat" class="icon-btn" title="New chat" aria-label="New chat"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
    </header>
    <section id="messages" class="messages" aria-live="polite">
      <div id="empty" class="welcome">
        <div class="welcome-mark">✦</div>
        <h1>What can I help you build?</h1>
        <p>Jcode can inspect your workspace, edit files, run commands, and validate the result.</p>
        <div class="starters">
          <button class="starter" data-prompt="Review this project and identify the highest-impact improvement."><span class="starter-icon">⌁</span><span>Review this project</span></button>
          <button class="starter" data-prompt="Find and fix a bug in this workspace. Validate the fix."><span class="starter-icon">◇</span><span>Find and fix a bug</span></button>
          <button class="starter" data-prompt="Explain the architecture of this codebase and its main data flow."><span class="starter-icon">◎</span><span>Explain the architecture</span></button>
        </div>
      </div>
    </section>
    <footer class="composer-zone">
      <div id="slash-menu" class="slash-menu" role="listbox" aria-label="Slash commands"></div>
      <div id="selection" class="selection-chip" title=""><span>⌁</span><span id="selection-label"></span></div>
      <div class="composer">
        <div id="attachments" class="pending-attachments"></div>
        <textarea id="prompt" class="prompt" rows="3" aria-label="Message Jcode" placeholder="Ask Jcode… Type / for commands"></textarea>
        <div class="composer-tools">
          <div class="tool-left">
            <button id="attach" class="small-btn" type="button" title="Attach files or images"><svg viewBox="0 0 24 24"><path d="M12 17V7a4 4 0 0 1 8 0v9a7 7 0 0 1-14 0V6a2 2 0 0 1 4 0v10a3 3 0 0 0 6 0V8"/></svg><span>Attach</span></button>
            <button id="selection-toggle" class="small-btn active" type="button" title="Include current editor selection"><svg viewBox="0 0 24 24"><path d="M8 5H5v3M16 5h3v3M8 19H5v-3M16 19h3v-3M9 9h6v6H9z"/></svg><span>Selection</span></button>
          </div>
          <div class="tool-right">
            <input id="model" class="model-input" list="model-suggestions" autocomplete="off" spellcheck="false" placeholder="Model: auto" aria-label="Model">
            <datalist id="model-suggestions"></datalist>
            <select id="effort" class="effort-select" aria-label="Reasoning effort"></select>
            <button id="cancel" class="send-btn" type="button" title="Cancel response" aria-label="Cancel response"><svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1"/></svg></button>
            <button id="send" class="send-btn" type="button" title="Send message" aria-label="Send message"><svg viewBox="0 0 24 24"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg></button>
          </div>
        </div>
      </div>
      <div class="composer-hint">Enter to send · Shift+Enter for a new line · paste images directly</div>
    </footer>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const empty = document.getElementById("empty");
    const prompt = document.getElementById("prompt");
    const selection = document.getElementById("selection");
    const selectionLabel = document.getElementById("selection-label");
    const selectionToggle = document.getElementById("selection-toggle");
    const attachmentList = document.getElementById("attachments");
    const slashMenu = document.getElementById("slash-menu");
    const modelInput = document.getElementById("model");
    const modelSuggestions = document.getElementById("model-suggestions");
    const effortSelect = document.getElementById("effort");
    const saved = vscode.getState() || { messages: [] };
    let liveBubble;
    let attachments = [];
    let slashCommands = [];
    let slashMatches = [];
    let slashIndex = 0;
    let includeSelection = true;
    let submitting = false;
    let pendingDraft = "";
    let activeTurnId;
    let pendingPastes = 0;

    function persist() {
      const items = [...messages.querySelectorAll(".chat[data-role]")].map(function (item) {
        return {
          role: item.dataset.role,
          text: item.querySelector(".chat-bubble").textContent,
          meta: item.querySelector(".chat-footer")?.textContent || "",
          attachments: JSON.parse(item.dataset.attachments || "[]"),
        };
      });
      vscode.setState({ messages: items });
    }

    function attachmentIcon(kind) { return kind === "image" ? "▧" : "▤"; }

    function createMessageAttachments(items) {
      if (!items || !items.length) return undefined;
      const wrap = document.createElement("div");
      wrap.className = "message-attachments";
      items.forEach(function (file) {
        const chip = document.createElement("div");
        chip.className = "message-file";
        const icon = document.createElement("b");
        icon.textContent = attachmentIcon(file.kind);
        const name = document.createElement("span");
        name.textContent = file.name;
        chip.append(icon, name);
        wrap.append(chip);
      });
      return wrap;
    }

    function appendMessage(role, text, meta, files) {
      empty.hidden = true;
      const item = document.createElement("article");
      item.className = "chat " + (role === "user" ? "chat-user" : "chat-assistant");
      item.dataset.role = role;
      item.dataset.attachments = JSON.stringify(files || []);
      const header = document.createElement("div");
      header.className = "chat-header";
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = role === "user" ? "Y" : "J";
      const label = document.createElement("span");
      label.textContent = role === "user" ? "You" : "Jcode";
      header.append(avatar, label);
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      bubble.textContent = text;
      item.append(header);
      const fileWrap = createMessageAttachments(files);
      if (fileWrap) item.append(fileWrap);
      item.append(bubble);
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
      item.className = "chat chat-assistant";
      item.dataset.role = "assistant";
      item.dataset.attachments = "[]";
      const header = document.createElement("div");
      header.className = "chat-header";
      header.innerHTML = '<span class="avatar">J</span><span>Jcode</span>';
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      const footer = document.createElement("div");
      footer.className = "chat-footer";
      item.append(header, bubble, footer);
      messages.append(item);
      messages.scrollTop = messages.scrollHeight;
      return { item: item, bubble: bubble, footer: footer };
    }

    function finalizeLiveBubble(meta) {
      if (!liveBubble) return;
      liveBubble.footer.textContent = meta || "";
      liveBubble = undefined;
      persist();
    }

    function appendNotice(text, isError) {
      empty.hidden = true;
      const notice = document.createElement("div");
      notice.className = "notice" + (isError ? " error" : "");
      notice.textContent = text;
      messages.append(notice);
      messages.scrollTop = messages.scrollHeight;
    }

    function appendCommandCard(title, rows) {
      empty.hidden = true;
      const card = document.createElement("section");
      card.className = "command-card";
      const heading = document.createElement("div");
      heading.className = "command-title";
      heading.textContent = title;
      card.append(heading);
      (rows || []).forEach(function (row) {
        const line = document.createElement("div");
        line.className = "command-row";
        const key = document.createElement("code");
        key.textContent = row[0];
        const value = document.createElement("span");
        value.textContent = row[1];
        line.append(key, value);
        card.append(line);
      });
      messages.append(card);
      messages.scrollTop = messages.scrollHeight;
    }

    function setSelection(label) {
      selectionLabel.textContent = label || "";
      selection.title = label || "";
      selection.classList.toggle("visible", Boolean(label) && includeSelection);
    }

    function formatBytes(size) {
      if (!size) return "";
      if (size < 1024) return size + " B";
      if (size < 1024 * 1024) return Math.round(size / 1024) + " KB";
      return (size / (1024 * 1024)).toFixed(1) + " MB";
    }

    function renderAttachments(items) {
      attachments = items || [];
      attachmentList.replaceChildren();
      attachments.forEach(function (file) {
        const chip = document.createElement("div");
        chip.className = "attachment-chip";
        chip.title = file.name + (file.size ? " · " + formatBytes(file.size) : "");
        const kind = document.createElement("span");
        kind.className = "attachment-kind";
        kind.textContent = attachmentIcon(file.kind);
        const name = document.createElement("span");
        name.className = "attachment-name";
        name.textContent = file.name;
        const remove = document.createElement("button");
        remove.className = "attachment-remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "Remove attachment";
        remove.setAttribute("aria-label", "Remove " + file.name);
        remove.addEventListener("click", function () { vscode.postMessage({ type: "removeAttachment", id: file.id }); });
        chip.append(kind, name, remove);
        attachmentList.append(chip);
      });
      attachmentList.classList.toggle("visible", attachments.length > 0);
    }

    function populateModelOptions(models) {
      modelSuggestions.replaceChildren();
      (models || []).forEach(function (name) {
        const option = document.createElement("option");
        option.value = name;
        modelSuggestions.append(option);
      });
    }

    function populateEffortOptions(levels) {
      effortSelect.replaceChildren();
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "auto";
      effortSelect.append(auto);
      (levels || []).forEach(function (level) {
        const option = document.createElement("option");
        option.value = level;
        option.textContent = level;
        effortSelect.append(option);
      });
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
      modelInput.disabled = running;
      effortSelect.disabled = running;
      document.getElementById("attach").disabled = running;
      let typing = document.getElementById("typing");
      if (running && !typing) {
        typing = document.createElement("article");
        typing.id = "typing";
        typing.className = "chat chat-assistant";
        typing.innerHTML = '<div class="chat-header"><span class="avatar">J</span><span>Jcode</span></div><div class="typing" aria-label="Jcode is responding"><i></i><i></i><i></i></div>';
        messages.append(typing);
        messages.scrollTop = messages.scrollHeight;
      } else if (!running) {
        typing?.remove();
        finalizeLiveBubble();
      }
    }

    function resizePrompt() {
      prompt.style.height = "auto";
      prompt.style.height = Math.min(prompt.scrollHeight, 200) + "px";
    }

    function commandQuery() {
      const value = prompt.value.trimStart();
      if (!value.startsWith("/") || value.includes("\n") || /\s/.test(value)) return undefined;
      return value.toLowerCase();
    }

    function renderSlashMenu() {
      const query = commandQuery();
      slashMenu.replaceChildren();
      if (query === undefined) {
        slashMatches = [];
        slashMenu.classList.remove("visible");
        return;
      }
      slashMatches = slashCommands.filter(function (command) {
        return command.name.toLowerCase().startsWith(query) || command.name.toLowerCase().includes(query.slice(1));
      }).slice(0, 9);
      slashIndex = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
      slashMatches.forEach(function (command, index) {
        const item = document.createElement("button");
        item.className = "slash-item" + (index === slashIndex ? " selected" : "");
        item.type = "button";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", index === slashIndex ? "true" : "false");
        const name = document.createElement("code");
        name.textContent = command.usage || command.name;
        const description = document.createElement("span");
        description.textContent = command.description;
        item.append(name, description);
        item.addEventListener("mousedown", function (event) { event.preventDefault(); acceptSlash(index); });
        slashMenu.append(item);
      });
      slashMenu.classList.toggle("visible", slashMatches.length > 0);
    }

    function acceptSlash(index) {
      const command = slashMatches[index];
      if (!command) return false;
      const current = prompt.value.trim();
      if (current === command.name && !command.usage) return false;
      prompt.value = command.name + (command.usage ? " " : "");
      prompt.focus();
      slashIndex = 0;
      resizePrompt();
      renderSlashMenu();
      return true;
    }

    function send() {
      const text = prompt.value.trim();
      if (!text || submitting || document.body.classList.contains("running")) return;
      if (pendingPastes > 0) {
        appendNotice("Wait for the pasted image to finish attaching.", false);
        return;
      }
      submitting = true;
      pendingDraft = prompt.value;
      document.getElementById("send").disabled = true;
      vscode.postMessage({
        type: "send",
        text: text,
        includeSelection: includeSelection,
        model: modelInput.value.trim(),
        effort: effortSelect.value,
        attachmentIds: attachments.map(function (file) { return file.id; }),
      });
      prompt.value = "";
      slashMenu.classList.remove("visible");
      resizePrompt();
    }

    (saved.messages || []).forEach(function (item) { appendMessage(item.role, item.text, item.meta, item.attachments); });
    empty.hidden = Boolean((saved.messages || []).length);

    document.querySelectorAll(".starter").forEach(function (button) {
      button.addEventListener("click", function () { prompt.value = button.dataset.prompt || ""; resizePrompt(); prompt.focus(); });
    });
    prompt.addEventListener("input", function () { resizePrompt(); slashIndex = 0; renderSlashMenu(); });
    prompt.addEventListener("keydown", function (event) {
      if (slashMenu.classList.contains("visible") && slashMatches.length) {
        if (event.key === "ArrowDown") { event.preventDefault(); slashIndex = (slashIndex + 1) % slashMatches.length; renderSlashMenu(); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length; renderSlashMenu(); return; }
        if (event.key === "Tab") { event.preventDefault(); acceptSlash(slashIndex); return; }
        if (event.key === "Escape") { event.preventDefault(); slashMenu.classList.remove("visible"); return; }
        if (event.key === "Enter" && !event.shiftKey) {
          const exact = slashMatches.find(function (command) { return command.name === prompt.value.trim(); });
          if (!exact && acceptSlash(slashIndex)) { event.preventDefault(); return; }
        }
      }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
    });
    prompt.addEventListener("paste", function (event) {
      const files = [...(event.clipboardData?.files || [])].filter(function (file) { return file.type.startsWith("image/"); });
      files.forEach(function (file) {
        pendingPastes += 1;
        const reader = new FileReader();
        reader.addEventListener("load", function () {
          const result = String(reader.result || "");
          vscode.postMessage({ type: "addPastedImage", name: file.name || "Pasted image", mediaType: file.type, data: result.split(",")[1] || "" });
          pendingPastes -= 1;
        });
        reader.addEventListener("error", function () { pendingPastes -= 1; appendNotice("Could not read the pasted image.", true); });
        reader.readAsDataURL(file);
      });
    });

    document.getElementById("send").addEventListener("click", send);
    document.getElementById("cancel").addEventListener("click", function () { vscode.postMessage({ type: "cancel" }); });
    document.getElementById("new-chat").addEventListener("click", function () { vscode.postMessage({ type: "newChat" }); });
    document.getElementById("terminal").addEventListener("click", function () { vscode.postMessage({ type: "openTerminal" }); });
    document.getElementById("attach").addEventListener("click", function () { vscode.postMessage({ type: "chooseAttachments" }); });
    selectionToggle.addEventListener("click", function () {
      includeSelection = !includeSelection;
      selectionToggle.classList.toggle("active", includeSelection);
      selectionToggle.setAttribute("aria-pressed", includeSelection ? "true" : "false");
      selection.classList.toggle("visible", includeSelection && Boolean(selectionLabel.textContent));
    });
    modelInput.addEventListener("change", function () { vscode.postMessage({ type: "model", model: modelInput.value.trim() }); });
    effortSelect.addEventListener("change", function () { vscode.postMessage({ type: "effort", effort: effortSelect.value }); });
    window.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && document.body.classList.contains("running")) {
        event.preventDefault();
        vscode.postMessage({ type: "cancel" });
      }
    });

    window.addEventListener("message", function (event) {
      const data = event.data;
      switch (data.type) {
        case "restore":
          setSelection(data.selection);
          applyOptions(data);
          slashCommands = data.slashCommands || [];
          renderAttachments(data.attachments || []);
          document.getElementById("session-status").textContent = data.error ? "Disconnected" : "Ready";
          if (data.error) appendNotice(data.error, true);
          break;
        case "bootstrap":
          setSelection(data.selection);
          applyOptions(data);
          slashCommands = data.slashCommands || [];
          renderAttachments(data.attachments || []);
          document.getElementById("session-status").textContent = "Connecting…";
          break;
        case "selection": setSelection(data.selection); if (data.focusComposer) prompt.focus(); break;
        case "attachments": renderAttachments(data.attachments); break;
        case "options": if (data.model !== undefined) modelInput.value = data.model; if (data.effort !== undefined) effortSelect.value = data.effort; break;
        case "user": appendMessage("user", data.text, data.selection || "", data.attachments || []); setSelection(""); break;
        case "sendAccepted":
        case "sendHandled":
          submitting = false;
          pendingDraft = "";
          document.getElementById("send").disabled = false;
          break;
        case "sendRejected":
          submitting = false;
          if (!prompt.value && pendingDraft) prompt.value = pendingDraft;
          pendingDraft = "";
          document.getElementById("send").disabled = false;
          resizePrompt();
          break;
        case "delta": if (data.turnId !== undefined && data.turnId !== activeTurnId) break; if (!liveBubble) liveBubble = createLiveBubble(); liveBubble.bubble.textContent += data.text; messages.scrollTop = messages.scrollHeight; break;
        case "assistant":
          if (data.turnId !== undefined && data.turnId !== activeTurnId) break;
          if (liveBubble) { liveBubble.bubble.textContent = data.text; liveBubble.footer.textContent = [data.provider, data.model].filter(Boolean).join(" · "); liveBubble = undefined; persist(); }
          else appendMessage("assistant", data.text, [data.provider, data.model].filter(Boolean).join(" · "), []);
          break;
        case "notice": appendNotice(data.text, false); break;
        case "error": appendNotice(data.text, true); break;
        case "running":
          if (data.running) activeTurnId = data.turnId;
          else if (data.turnId !== undefined && data.turnId !== activeTurnId) break;
          if (!data.running) activeTurnId = undefined;
          setRunning(data.running);
          document.getElementById("session-status").textContent = data.running ? "Working…" : "Ready";
          break;
        case "commandHelp": appendCommandCard("Jcode commands", (data.commands || []).map(function (command) { return [command.usage || command.name, command.description]; })); break;
        case "commandInfo": appendCommandCard(data.title || "Info", data.rows || []); break;
        case "openModelPicker": modelInput.focus(); modelInput.select(); break;
        case "openEffortPicker": effortSelect.focus(); break;
        case "cleared":
          activeTurnId = undefined;
          submitting = false;
          pendingDraft = "";
          document.getElementById("send").disabled = false;
          liveBubble = undefined;
          messages.querySelectorAll(":scope > :not(#empty)").forEach(function (node) { node.remove(); });
          empty.hidden = false;
          setSelection("");
          renderAttachments([]);
          vscode.setState({ messages: [] });
          prompt.focus();
          break;
      }
    });

    vscode.postMessage({ type: "ready", hasHistory: Boolean((saved.messages || []).length) });
  </script>
</body>
</html>`;
}
function getNonce() {
  return crypto.randomBytes(24).toString("base64");
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
