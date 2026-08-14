// jcode VS Code extension.
//
// Full wrapper around the jcode harness API (protocol v1), served by
// `jcode api-bridge` over a Unix socket. The official TypeScript SDK
// (@1jehuang/jcode-sdk) is bundled with the extension; the bridge is started
// automatically the first time it is needed and shared with the user's own
// jcode, so sessions created here are the same ones the terminal TUI shows.
//
// Layout:
//   extension.js   this file: activation, connection manager, chat provider
//   media/chat.js  webview client (external file, syntax-checkable)
//   media/chat.css webview styles
//   media/chat.html is generated inline by getChatHtml() below (small shell
//   that references the external assets via webview.asWebviewUri).

const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const vscode = require("vscode");

const TERMINAL_NAME = "Jcode";
const CHAT_VIEW_ID = "jcode.chatView";
const CHAT_SESSION_KEY = "jcode.chat.sessionId";
const CHAT_MODEL_KEY = "jcode.chat.model";
const CHAT_MODEL_ROUTE_KEY = "jcode.chat.modelRoute";
const CHAT_EFFORT_KEY = "jcode.chat.effort";
const CHAT_BOOKMARKS_KEY = "jcode.chat.bookmarks";
const CHAT_RUNTIME_STATES_KEY = "jcode.chat.runtimeStates";
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
const CLIENT_NAME = "jcode-vscode/0.9.0";
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

// Slash command catalog. Mirrors the TUI's REGISTERED_COMMANDS
// (crates/jcode-tui/.../state_ui_input_helpers.rs, jcode v0.76.0) with an
// extra `tier` field describing how the sidebar handles each command:
//   native   -> implemented directly against the SDK (T1)
//   prompt   -> same mechanism as the TUI: a prompt template sent as a
//               synthetic user turn (T2)
//   cli      -> runs `jcode <subcommand>` and shows the output (T3)
//   local    -> implemented with extension-local state/UI (T4)
//   terminal -> opens the terminal agent with the command prefilled (T5)
const SLASH_COMMANDS = [
  { name: "/help", usage: "/help", description: "Show commands available in the sidebar", tier: "local" },
  { name: "/?", usage: "/?", description: "Alias for /help", tier: "local", hidden: true },
  { name: "/commands", usage: "/commands", description: "Alias for /help", tier: "local", hidden: true },
  { name: "/model", usage: "/model [name]", description: "List or switch models", tier: "native" },
  { name: "/models", usage: "/models [name]", description: "Alias for /model", tier: "native", hidden: true },
  { name: "/effort", usage: "/effort [level]", description: "Show or set reasoning effort", tier: "native" },
  { name: "/cancel", usage: "/cancel", description: "Cancel the current prompt or operation", tier: "native" },
  { name: "/clear", usage: "/clear", description: "Clear conversation history", tier: "native" },
  { name: "/cls", usage: "/cls", description: "Clear the view only, keeping context", tier: "local" },
  { name: "/rewind", usage: "/rewind [index]", description: "Rewind conversation to a previous message", tier: "native" },
  { name: "/compact", usage: "/compact", description: "Compact context", tier: "native" },
  { name: "/rename", usage: "/rename <title>", description: "Rename the current session", tier: "native" },
  { name: "/info", usage: "/info", description: "Show session, provider, model, and runtime info", tier: "native" },
  { name: "/context", usage: "/context", description: "Show the session context snapshot", tier: "native" },
  { name: "/resume", usage: "/resume", description: "Open the session picker", tier: "native" },
  { name: "/sessions", usage: "/sessions", description: "Alias for /resume", tier: "native", hidden: true },
  { name: "/session", usage: "/session", description: "Alias for /resume", tier: "native", hidden: true },
  { name: "/save", usage: "/save [label]", description: "Bookmark this session for easy access", tier: "local" },
  { name: "/unsave", usage: "/unsave", description: "Remove the bookmark from this session", tier: "local" },
  { name: "/commit", usage: "/commit", description: "Make logical commits from current changes", tier: "prompt" },
  { name: "/commit-push", usage: "/commit-push", description: "Make logical commits, then push", tier: "prompt" },
  { name: "/plan", usage: "/plan", description: "Create a plan-only response as a plan card", tier: "prompt" },
  { name: "/improve", usage: "/improve", description: "Autonomously improve the repository", tier: "prompt" },
  { name: "/refactor", usage: "/refactor", description: "Run a safe refactor loop", tier: "prompt" },
  { name: "/fix", usage: "/fix", description: "Recover when the model cannot continue", tier: "prompt" },
  { name: "/test", usage: "/test", description: "Verify current changes with layered tests", tier: "prompt" },
  { name: "/todos", usage: "/todos", description: "Show the session todo list", tier: "prompt" },
  { name: "/poke", usage: "/poke", description: "Poke the model to resume with incomplete todos", tier: "prompt" },
  { name: "/review", usage: "/review", description: "Launch a one-shot headed review session", tier: "prompt" },
  { name: "/judge", usage: "/judge", description: "Launch a one-shot headed judge session", tier: "prompt" },
  { name: "/autoreview", usage: "/autoreview [on|off]", description: "Show/toggle automatic end-of-turn review", tier: "prompt" },
  { name: "/autojudge", usage: "/autojudge [on|off]", description: "Show/toggle automatic end-of-turn judging", tier: "prompt" },
  { name: "/initiatives", usage: "/initiatives", description: "Open initiatives overview / resume tracked initiatives", tier: "prompt" },
  { name: "/goals", usage: "/goals", description: "Legacy alias for /initiatives", tier: "prompt", hidden: true },
  { name: "/btw", usage: "/btw <question>", description: "Ask a side question", tier: "prompt" },
  { name: "/observe", usage: "/observe", description: "Show the latest tool context", tier: "prompt" },
  { name: "/overnight", usage: "/overnight", description: "Run a supervised overnight coordinator", tier: "prompt" },
  { name: "/swarm", usage: "/swarm", description: "Toggle swarm feature", tier: "prompt" },
  { name: "/usage", usage: "/usage", description: "Show connected provider usage limits", tier: "cli", cli: ["usage"] },
  { name: "/version", usage: "/version", description: "Show current version", tier: "cli", cli: ["version"] },
  { name: "/memory", usage: "/memory [list|search <q>]", description: "Show or search stored memories", tier: "cli", cli: ["memory", "list"] },
  { name: "/telemetry", usage: "/telemetry [status|enable|disable]", description: "Show or change what jcode sends", tier: "cli", cli: ["telemetry", "status"] },
  { name: "/provider-test-coverage", usage: "/provider-test-coverage", description: "Show live-test evidence for the current provider/model", tier: "cli", cli: ["provider-test-coverage"] },
  { name: "/model-status", usage: "/model-status", description: "Alias for /provider-test-coverage", tier: "cli", cli: ["provider-test-coverage"], hidden: true },
  { name: "/refresh-model-list", usage: "/refresh-model-list", description: "Refresh provider model catalogs", tier: "cli", cli: ["model", "list"] },
  { name: "/auth", usage: "/auth", description: "Show authentication status", tier: "cli", cli: ["auth"] },
  { name: "/login", usage: "/login", description: "Login to a provider (opens in terminal)", tier: "terminal", command: "/login" },
  { name: "/logout", usage: "/logout", description: "Log out of a provider (opens in terminal)", tier: "terminal", command: "/logout" },
  { name: "/account", usage: "/account", description: "Open the combined account picker (terminal)", tier: "terminal", command: "/account" },
  { name: "/accounts", usage: "/accounts", description: "Alias for /account", tier: "terminal", command: "/account", hidden: true },
  { name: "/update", usage: "/update", description: "Update jcode (opens in terminal)", tier: "terminal", command: "/update" },
  { name: "/permissions", usage: "/permissions", description: "Review pending permission requests (terminal)", tier: "terminal", command: "/permissions" },
  { name: "/transcript", usage: "/transcript", description: "Open the session transcript (terminal)", tier: "terminal", command: "/transcript" },
  { name: "/config", usage: "/config", description: "Open VS Code settings for jcode", tier: "local" },
  { name: "/keys", usage: "/keys", description: "Show keybinding conflicts (terminal)", tier: "terminal", command: "/keys" },
  { name: "/hotkeys", usage: "/hotkeys", description: "List hotkeys (terminal)", tier: "terminal", command: "/hotkeys" },
  { name: "/colors", usage: "/colors", description: "List and configure TUI colors (terminal)", tier: "terminal", command: "/colors" },
  { name: "/changelog", usage: "/changelog", description: "Show recent changes (terminal)", tier: "terminal", command: "/changelog" },
  { name: "/diff", usage: "/diff [mode]", description: "Set diff display mode (terminal)", tier: "terminal", command: "/diff" },
  { name: "/thinking-display", usage: "/thinking-display [off|full|current]", description: "Show/hide thinking text (terminal)", tier: "terminal", command: "/thinking-display" },
  { name: "/tool-call-details", usage: "/tool-call-details", description: "Toggle tool call details (terminal)", tier: "terminal", command: "/tool-call-details" },
  { name: "/show-agentgrep-output", usage: "/show-agentgrep-output", description: "Toggle agentgrep output (terminal)", tier: "terminal", command: "/show-agentgrep-output" },
  { name: "/compact-notifications", usage: "/compact-notifications [on|off]", description: "Toggle notification style (terminal)", tier: "terminal", command: "/compact-notifications" },
  { name: "/alignment", usage: "/alignment [left|center]", description: "Set text alignment (terminal)", tier: "terminal", command: "/alignment" },
  { name: "/fast", usage: "/fast", description: "Toggle fast mode (terminal)", tier: "terminal", command: "/fast" },
  { name: "/transport", usage: "/transport", description: "Show/change connection transport (terminal)", tier: "terminal", command: "/transport" },
  { name: "/terminal-setup", usage: "/terminal-setup", description: "Fix Shift+Enter newlines (terminal)", tier: "terminal", command: "/terminal-setup" },
  { name: "/screenshot", usage: "/screenshot", description: "Capture a screenshot debug state (terminal)", tier: "terminal", command: "/screenshot" },
  { name: "/record", usage: "/record", description: "Record a demo capture (terminal)", tier: "terminal", command: "/record" },
  { name: "/reload", usage: "/reload", description: "Reload into the newest binary (terminal)", tier: "terminal", command: "/reload" },
  { name: "/restart", usage: "/restart", description: "Restart with the current binary (terminal)", tier: "terminal", command: "/restart" },
  { name: "/rebuild", usage: "/rebuild", description: "Background rebuild and reload (terminal)", tier: "terminal", command: "/rebuild" },
  { name: "/selfdev", usage: "/selfdev", description: "Open a new self-dev jcode session (terminal)", tier: "terminal", command: "/selfdev" },
  { name: "/remote", usage: "/remote", description: "Reach this session from another machine (terminal)", tier: "terminal", command: "/remote" },
  { name: "/continue", usage: "/continue", description: "Continue interrupted live sessions (terminal)", tier: "terminal", command: "/continue" },
  { name: "/resumeall", usage: "/resumeall", description: "Alias for /continue (terminal)", tier: "terminal", command: "/continue", hidden: true },
  { name: "/ssh", usage: "/ssh", description: "Connect to a remote machine via SSH (terminal)", tier: "terminal", command: "/ssh" },
  { name: "/git", usage: "/git", description: "Show git status for the working directory (terminal)", tier: "terminal", command: "/git" },
  { name: "/skills", usage: "/skills", description: "Show loaded skills (terminal)", tier: "terminal", command: "/skills" },
  { name: "/agents", usage: "/agents", description: "Configure models for agent roles (terminal)", tier: "terminal", command: "/agents" },
  { name: "/subagent", usage: "/subagent", description: "Launch a subagent manually (terminal)", tier: "terminal", command: "/subagent" },
  { name: "/fork", usage: "/fork [prompt]", description: "Fork the session into a new window (terminal)", tier: "terminal", command: "/fork" },
  { name: "/transfer", usage: "/transfer", description: "Hand off context into a fresh session (terminal)", tier: "terminal", command: "/transfer" },
  { name: "/workspace", usage: "/workspace", description: "Niri-style session workspace (terminal)", tier: "terminal", command: "/workspace" },
  { name: "/catchup", usage: "/catchup", description: "Open the Catch Up picker (terminal)", tier: "terminal", command: "/catchup" },
  { name: "/active", usage: "/active", description: "Manage live sessions (terminal)", tier: "terminal", command: "/active" },
  { name: "/quit", usage: "/quit", description: "Exit jcode (not available in the sidebar)", tier: "terminal", command: "/quit", hidden: true },
];

// Prompt templates for tier "prompt" commands, mirroring the TUI's
// build_*_prompt() synthetic user turns.
const PROMPT_COMMANDS = {
  "/commit": "Create logical commits from the current changes. Inspect `git status` and the diffs, then commit the work in logical units with clear, conventional messages. Do not push.",
  "/commit-push": "Create logical commits from the current changes, then push them to the remote. Inspect `git status` and the diffs first, and commit in logical units with clear, conventional messages.",
  "/plan": "Create a plan-only response. Analyze the current request and repository, then produce a step-by-step plan as a structured plan card. Do not make any changes yet.",
  "/improve": "Autonomously improve this repository. Identify the highest-impact improvements, implement them safely, and validate the result with tests or checks. Keep changes focused and explain each one.",
  "/refactor": "Run a safe refactor loop on the current code: identify refactoring opportunities, apply them incrementally, and validate after each step that nothing broke.",
  "/fix": "Recover from the current state: diagnose why progress stalled or broke, then fix it with one small verifiable task at a time. Do not continue blindly.",
  "/test": "Verify the current claims and changes with layered tests. Identify the right test levels, run the relevant checks, and fix what fails. Report the evidence.",
  "/todos": "Show the current session todo list as a structured list, with status for each item.",
  "/poke": "Resume the current work. Review the incomplete todos and continue making progress on them, one small verifiable task at a time.",
  "/review": "Run a thorough review of the current changes. Inspect the diffs for correctness, risks, and regressions, and report findings with concrete suggestions.",
  "/judge": "Judge the quality of the last response: correctness, completeness, and clarity. Score it and list the most important improvements.",
  "/autoreview": "Review the work completed in this turn. Inspect the changes for correctness, risks, and regressions, and report findings.",
  "/autojudge": "Judge the quality of the work completed in this turn. Score it and list the most important improvements.",
  "/initiatives": "Show the current initiatives overview. List tracked initiatives, their milestones, and current progress.",
  "/goals": "Show the current initiatives overview. List tracked initiatives, their milestones, and current progress.",
  "/btw": "Answer this side question concisely without changing anything in the repository:",
  "/observe": "Show the latest tool context and what the agent is currently working on.",
  "/overnight": "Run a supervised overnight coordinator: break the current goals into small verifiable tasks and work through them methodically, reporting progress and stopping when blocked.",
  "/swarm": "Toggle swarm mode for this session and explain what changed.",
};

let jcodeTerminal;
let lastTextEditor;
let outputChannel;

function log(...parts) {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Jcode");
  }
  outputChannel.appendLine(
    `[${new Date().toLocaleTimeString()}] ${parts.map((part) => (part instanceof Error ? part.stack || part.message : String(part))).join(" ")}`,
  );
}

// The chat backend talks to the user's jcode through the official TypeScript
// SDK (@1jehuang/jcode-sdk), which dials the `jcode api-bridge` Unix socket.
// The bridge is started automatically (detached) the first time it is needed,
// unless one is already running.
let sdkPromise;
let clientPromise;
let currentClient;
let bridgeProcess;
let extensionApiSocket;

function getSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.race([
      import("@1jehuang/jcode-sdk"),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out after 10s while loading the Jcode SDK module")),
          10000,
        ),
      ),
    ]).catch((error) => {
      sdkPromise = undefined;
      const message =
        `The Jcode TypeScript SDK could not be loaded (${errorMessage(error)}). ` +
        "Install extension dependencies with \"npm install\" in the extension folder, then reload the window.";
      log(message);
      throw new Error(message);
    });
  }
  return sdkPromise;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms: ${label}`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  if (currentClient?.closed) {
    currentClient = undefined;
    clientPromise = undefined;
  }
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
  const apiSocket = getApiSocketPath();
  log(`connecting to harness API at ${apiSocket || "<default socket>"}`);
  try {
    const client = await withTimeout(
      JcodeClient.connect({ clientName: CLIENT_NAME, socketPath: apiSocket }),
      5000,
      "dialing the harness API socket",
    );
    watchClientLiveness(client);
    log("connected to existing harness API");
    return client;
  } catch (firstError) {
    if (firstError?.code !== "connect_failed") {
      log(`harness API connection rejected: ${errorMessage(firstError)}`);
      throw firstError;
    }
    log(`no harness API at ${apiSocket || "<default socket>"}: starting api-bridge`);
    removeOwnedStaleSocket(apiSocket);
    spawnBridge(apiSocket);
    const deadline = Date.now() + BRIDGE_CONNECT_TIMEOUT_MS;
    let lastError = firstError;
    while (Date.now() < deadline) {
      await sleep(300);
      if (!bridgeProcess || bridgeProcess.exitCode !== null || bridgeProcess.signalCode !== null) {
        spawnBridge(apiSocket);
      }
      try {
        const client = await withTimeout(
          JcodeClient.connect({ clientName: CLIENT_NAME, socketPath: apiSocket }),
          5000,
          "dialing the harness API socket",
        );
        watchClientLiveness(client);
        log("connected to spawned harness API");
        return client;
      } catch (error) {
        lastError = error;
      }
    }
    const message =
      `Could not reach the Jcode harness API (${errorMessage(lastError)}). ` +
      "Make sure the Jcode CLI is installed and new enough to support `jcode api-bridge`. " +
      "Check the Jcode output channel for bridge diagnostics, or set `jcode.executablePath` to the absolute path of the jcode binary.";
    log(message);
    throw new Error(message);
  }
}

function getApiSocketPath() {
  if (process.env.JCODE_API_SOCKET) {
    return process.env.JCODE_API_SOCKET;
  }
  const configured = vscode.workspace.getConfiguration("jcode").get("apiSocketPath", "");
  if (typeof configured === "string" && configured) {
    return configured;
  }
  return extensionApiSocket;
}

function removeOwnedStaleSocket(apiSocket) {
  if (process.platform === "win32" || !apiSocket || apiSocket !== extensionApiSocket) return;
  try {
    fs.unlinkSync(apiSocket);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
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
  const executable = resolveJcodeExecutable(config.get("executablePath", "jcode"));
  const configuredArguments = config.get("launchArguments", []);
  const args = [...configuredArguments, "--no-update", "api-bridge"];
  if (apiSocket) {
    args.push("--api-socket", apiSocket);
  }
  log(`starting bridge: ${executable} ${args.join(" ")}`);
  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env },
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      log(`bridge stderr: ${chunk.trim()}`);
    });
    child.on("error", (error) => {
      log(`bridge spawn error: ${errorMessage(error)}`);
      if (bridgeProcess === child) bridgeProcess = undefined;
    });
    child.on("exit", (code, signal) => {
      log(`bridge exited: code=${code} signal=${signal}`);
      if (bridgeProcess === child) bridgeProcess = undefined;
    });
    child.unref();
    bridgeProcess = child;
  } catch (error) {
    log(`bridge spawn threw: ${errorMessage(error)}`);
  }
}

function resolveJcodeExecutable(configured) {
  if (configured !== "jcode") return configured;
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "jcode"),
    path.join(os.homedir(), ".jcode", "builds", "current", "jcode"),
    "/opt/homebrew/bin/jcode",
    "/usr/local/bin/jcode",
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Unreadable path; try the next candidate.
    }
  }
  return configured;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  log("extension activated");
  if (context.globalStorageUri.scheme === "file") {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    extensionApiSocket = path.join(context.globalStorageUri.fsPath, "api.sock");
  }
  lastTextEditor = vscode.window.activeTextEditor;
  const chatProvider = new JcodeChatProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("jcode.open", () => chatProvider.focus()),
    vscode.commands.registerCommand("jcode.diagnose", () => runDiagnostics(context)),
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
      vscode.commands.registerCommand("jcode._test.setModel", (model, displayModel, provider) =>
        chatProvider.setSelectedModel(model, false, displayModel ?? model, provider),
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
        const client = currentClient;
        currentClient = undefined;
        clientPromise = undefined;
        if (client) await client.close();
      }),
      vscode.commands.registerCommand("jcode._test.useMockView", () => {
        const posted = [];
        chatProvider.view = {
          webview: {
            postMessage: async (message) => {
              if (message.type === "running" && message.running) await sleep(20);
              posted.push(message);
              return true;
            },
          },
        };
        chatProvider.testPostedMessages = posted;
      }),
      vscode.commands.registerCommand("jcode._test.getPostedMessages", async () => {
        await chatProvider.postChain;
        return chatProvider.testPostedMessages || [];
      }),
      vscode.commands.registerCommand("jcode._test.getModelPickerItems", (models, routes, current, currentProvider, providers) =>
        buildModelQuickPickItems(models, routes, current, currentProvider, providers).map((item) => ({
          label: item.label,
          kind: item.kind,
          model: item.model,
          displayModel: item.displayModel,
          provider: item.provider,
          description: item.description,
          detail: item.detail,
        })),
      ),
    );
  }
}

async function runDiagnostics(context) {
  const config = vscode.workspace.getConfiguration("jcode");
  const executable = resolveJcodeExecutable(config.get("executablePath", "jcode"));
  const socket = getApiSocketPath();
  log("=== jcode diagnostics ===");
  log(`version: ${CLIENT_NAME}`);
  log(`executable: ${executable}`);
  log(`api socket: ${socket || "<SDK default>"}`);
  log(`launchArguments: ${JSON.stringify(config.get("launchArguments", []))}`);
  try {
    const client = await getJcodeClient();
    const info = await withTimeout(client.getRuntimeInfo(undefined), 5000, "runtime info");
    log(`connected: ${info.server} protocol=${info.protocolVersion} healthy=${info.healthy}`);
    log(`providers: ${(info.providers || []).join(", ")}`);
    const sessions = await client.listSessions();
    log(`sessions: ${sessions.length}`);
    void vscode.window.showInformationMessage(
      `Jcode connected (${info.server}). See the Jcode output channel for details.`,
    );
  } catch (error) {
    log(`diagnostics failed: ${errorMessage(error)}`);
    void vscode.window.showErrorMessage(`Jcode diagnostics failed: ${errorMessage(error)}`);
  }
}

const MODEL_PROVIDER_PREFIXES = [
  ["claude", "Anthropic"],
  ["gpt", "OpenAI"],
  ["codex", "OpenAI"],
  ["o1", "OpenAI"],
  ["o3", "OpenAI"],
  ["o4", "OpenAI"],
  ["gemini", "Google"],
  ["deepseek", "DeepSeek"],
  ["grok", "xAI"],
  ["glm", "Zhipu AI"],
  ["kimi", "Moonshot AI"],
  ["qwen", "Alibaba Cloud"],
  ["minimax", "MiniMax"],
];

function inferredModelProvider(model) {
  const normalized = String(model || "").toLowerCase();
  const qualified = normalized.match(/^([^/:]+)[/:]/);
  if (qualified) {
    const explicit = qualified[1];
    const known = MODEL_PROVIDER_PREFIXES.find(([prefix]) => explicit === prefix);
    return known ? known[1] : explicit.replace(/(^|[-_])\w/g, (part) => part.replace(/[-_]/, "").toUpperCase());
  }
  return MODEL_PROVIDER_PREFIXES.find(([prefix]) => normalized.startsWith(prefix))?.[1] || "Other";
}

function routeModelSpec(route) {
  const model = String(route?.model || "").trim();
  const method = String(route?.api_method || "").trim().toLowerCase();
  if (!model) return "";
  if (method === "claude-oauth") return `claude-oauth:${model}`;
  if (["claude-api", "anthropic-api", "anthropic-api-key", "claude-api-key"].includes(method)) {
    return `claude-api:${model}`;
  }
  if (["openai", "openai-oauth"].includes(method)) return `openai-oauth:${model}`;
  if (["openai-api", "openai-api-key", "openai-key", "openai-apikey"].includes(method)) {
    return `openai-api:${model}`;
  }
  if (method.startsWith("openai-compatible:")) {
    const profile = method.slice("openai-compatible:".length).trim();
    return profile ? `${profile}:${model}` : model;
  }
  if (["copilot", "cursor", "bedrock"].includes(method)) return `${method}:${model}`;
  if (method === "openrouter") {
    let catalogModel = model;
    if (!catalogModel.includes("/")) {
      const provider = inferredModelProvider(catalogModel);
      if (provider === "Anthropic") catalogModel = `anthropic/${catalogModel}`;
      if (provider === "OpenAI") catalogModel = `openai/${catalogModel}`;
    }
    const provider = String(route?.provider || "").trim();
    return !provider || provider.toLowerCase() === "auto" || catalogModel.includes("@")
      ? catalogModel
      : `${catalogModel}@${provider}`;
  }
  return model;
}

function buildModelQuickPickItems(models, routes, current, currentProvider, providers = []) {
  const names = Array.from(new Set((models || []).filter(Boolean)));
  if (current && !names.includes(current)) names.unshift(current);
  const validRoutes = [];
  const routeKeys = new Set();
  for (const route of routes || []) {
    if (!route?.model || !route?.provider) continue;
    const key = [route.provider, route.api_method || "", route.model].join("\u0000");
    if (routeKeys.has(key)) continue;
    routeKeys.add(key);
    validRoutes.push(route);
  }

  const groups = new Map();
  const ensureGroup = (provider) => {
    const label = String(provider || "Other");
    if (!groups.has(label)) groups.set(label, []);
    return groups.get(label);
  };
  for (const provider of providers || []) ensureGroup(provider);
  for (const route of validRoutes) ensureGroup(route.provider).push(route);

  const routedModels = new Set(validRoutes.map((route) => route.model));
  for (const model of names) {
    if (routedModels.has(model)) continue;
    const provider = model === current && currentProvider ? currentProvider : inferredModelProvider(model);
    ensureGroup(provider).push({ model, provider, available: true, inferred: true });
  }

  const items = [
    { label: "Automatic", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(sparkle) Auto",
      description: current ? undefined : "Current",
      detail: "Let Jcode select the model for each new chat",
      model: "",
      picked: !current,
    },
  ];
  const providerOrder = Array.from(groups.keys()).sort((a, b) => {
    if (a === currentProvider) return -1;
    if (b === currentProvider) return 1;
    return a.localeCompare(b);
  });
  for (const provider of providerOrder) {
    items.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
    const providerRoutes = groups.get(provider).sort((a, b) => {
      if (a.available !== b.available) return a.available === false ? 1 : -1;
      return String(a.model).localeCompare(String(b.model)) || String(a.api_method || "").localeCompare(String(b.api_method || ""));
    });
    for (const route of providerRoutes) {
      const model = route.model;
      const spec = route.inferred ? model : routeModelSpec(route);
      const isCurrent = model === current && (!currentProvider || provider.toLowerCase() === String(currentProvider).toLowerCase());
      const unavailable = route.available === false;
      const description = [isCurrent ? "Current" : "", unavailable ? "Unavailable" : ""].filter(Boolean).join(" · ") || undefined;
      const routeDetail = [route.api_method, route.detail].filter(Boolean).join(" · ");
      items.push({
        label: model,
        description,
        detail: routeDetail || provider,
        model: unavailable ? undefined : spec,
        displayModel: model,
        provider,
        route,
        picked: isCurrent,
      });
    }
  }
  return items;
}

const CONFIDENCE_LEVELS = ["speculative", "plausible", "validated", "verified"];

function displayTodoConfidence(todo) {
  return todo?.status === "completed"
    ? todo.completion_confidence || todo.confidence
    : todo?.confidence;
}

function aggregateTodoConfidence(todos) {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const todo of todos || []) {
    if (!todo || todo.status === "cancelled") continue;
    const confidence = displayTodoConfidence(todo);
    const score = CONFIDENCE_LEVELS.indexOf(confidence);
    if (score < 0) continue;
    const weight = todo.priority === "high" ? 3 : todo.priority === "medium" ? 2 : 1;
    weightedScore += score * weight;
    totalWeight += weight;
  }
  return totalWeight > 0
    ? CONFIDENCE_LEVELS[Math.max(0, Math.min(3, Math.round(weightedScore / totalWeight)))]
    : undefined;
}

function effectivePromptTokens(input, cacheRead) {
  const safeInput = Math.max(0, Number(input) || 0);
  const safeCacheRead = Math.max(0, Number(cacheRead) || 0);
  return safeCacheRead > safeInput ? safeInput + safeCacheRead : safeInput;
}

function inferredContextLimit(model, configuredLimit = 0) {
  if (Number(configuredLimit) > 0) return Number(configuredLimit);
  const name = String(model || "").toLowerCase().replace(/^.*[/:]/, "");
  if (name.includes("[1m]") || /claude-(opus-(5|4-8|4-7)|sonnet-5|fable-5)/.test(name)) return 1_000_000;
  if (name.startsWith("gpt-5.4")) return 1_000_000;
  if (name.startsWith("gpt-5")) return name.includes("chat") || name.includes("spark") ? 128_000 : 272_000;
  if (name.startsWith("gemini-2") || name.startsWith("gemini-3")) return 1_000_000;
  if (name.includes("deepseek-v4") || name.includes("glm-5.2")) return 1_000_000;
  if (name.includes("kimi") || /^k\d/.test(name)) return /(?:k3|k[4-9])/.test(name) ? 1_048_576 : 262_144;
  if (name.includes("qwen3") || name.includes("qwen-3") || name.includes("mimo")) return 262_144;
  if (name.includes("minimax")) return 204_800;
  if (name.includes("grok-code-fast")) return 256_000;
  return 200_000;
}

function isTodoToolName(name) {
  return String(name || "").split(".").pop() === "todo";
}

function emptyRuntimeState(model, configuredLimit) {
  return {
    todos: [],
    goals: [],
    aggregateConfidence: undefined,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    effectiveInputTokens: 0,
    contextTokens: 0,
    contextLimit: inferredContextLimit(model, configuredLimit),
    activeModel: model || undefined,
  };
}

class JcodeChatProvider {
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
    this.modelCatalog = { models: this.getModelList(), routes: [], providers: [], currentProvider: undefined };
    this.runtimeState = this.loadRuntimeState(this.context.workspaceState.get(CHAT_SESSION_KEY));
    this.disposed = false;
    this.nextTurnId = 1;
    this.activeTurnId = undefined;
    this.postChain = Promise.resolve();
    this.attachments = new Map();
    this.nextAttachmentId = 1;
    this.testPostedMessages = undefined;
  }

  resolveWebviewView(webviewView) {
    log("resolveWebviewView called");
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = getChatHtml(webviewView.webview, this.context);

    const messageSubscription = webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "ready":
          log(`webview ready received (hasHistory=${Boolean(message.hasHistory)}, sessionId=${this.sessionId || "none"})`);
          if (!message.hasHistory && !this.sessionId) {
            await this.context.workspaceState.update(CHAT_SESSION_KEY, undefined);
          }
          this.postBootstrap();
          log("bootstrap posted");
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
        case "chooseModel":
          await this.showModelPicker();
          break;
        case "effort":
          await this.setSelectedEffort(message.effort);
          break;
        case "attachSession":
          await this.attachToSession(message.sessionId);
          break;
        case "renameSession":
          await this.renameCurrentSession(message.sessionId, message.title);
          break;
        case "webviewError":
          log(`webview error: ${message.message}`);
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

  getSelectedModelRequest() {
    return this.context.workspaceState.get(CHAT_MODEL_ROUTE_KEY) || this.getSelectedModel();
  }

  getSelectedEffort() {
    const saved = this.context.workspaceState.get(CHAT_EFFORT_KEY);
    if (saved) {
      return saved;
    }
    return vscode.workspace.getConfiguration("jcode").get("defaultEffort", "");
  }

  configuredContextLimit() {
    return vscode.workspace.getConfiguration("jcode").get("contextWindowTokens", 0);
  }

  loadRuntimeState(sessionId) {
    const states = this.context.workspaceState.get(CHAT_RUNTIME_STATES_KEY, {});
    const saved = sessionId && states && typeof states === "object" ? states[sessionId] : undefined;
    return saved && typeof saved === "object"
      ? { ...emptyRuntimeState(this.getSelectedModel(), this.configuredContextLimit()), ...saved }
      : emptyRuntimeState(this.getSelectedModel(), this.configuredContextLimit());
  }

  async publishRuntimeState() {
    this.runtimeState.contextLimit = inferredContextLimit(
      this.runtimeState.activeModel || this.getSelectedModel(),
      this.configuredContextLimit(),
    );
    if (this.sessionId) {
      const states = { ...this.context.workspaceState.get(CHAT_RUNTIME_STATES_KEY, {}) };
      states[this.sessionId] = this.runtimeState;
      const sessionIds = Object.keys(states);
      while (sessionIds.length > 20) delete states[sessionIds.shift()];
      await this.context.workspaceState.update(CHAT_RUNTIME_STATES_KEY, states);
    }
    this.post({ type: "runtimeState", state: this.runtimeState });
  }

  updateRuntimeTodos(payload) {
    if (!payload || typeof payload !== "object") return;
    if (Array.isArray(payload.todos)) {
      this.runtimeState.todos = payload.todos.slice(0, 100).map((todo) => ({
        id: String(todo?.id || ""),
        content: String(todo?.content || "").slice(0, 1000),
        status: String(todo?.status || "pending"),
        priority: String(todo?.priority || "normal"),
        group: todo?.group == null ? undefined : String(todo.group).slice(0, 200),
        confidence: todo?.confidence || undefined,
        completion_confidence: todo?.completion_confidence || todo?.completionConfidence || undefined,
      }));
    }
    if (Array.isArray(payload.goals)) this.runtimeState.goals = payload.goals.slice(0, 50);
    this.runtimeState.aggregateConfidence = aggregateTodoConfidence(this.runtimeState.todos);
    void this.publishRuntimeState();
  }

  updateRuntimeUsage(event, model) {
    const input = Math.max(0, Number(event?.input) || 0);
    const output = Math.max(0, Number(event?.output) || 0);
    const cacheRead = Math.max(0, Number(event?.cache_read_input ?? event?.cacheReadInput) || 0);
    const effectiveInput = effectivePromptTokens(input, cacheRead);
    this.runtimeState.inputTokens += input;
    this.runtimeState.outputTokens += output;
    this.runtimeState.cacheReadTokens += cacheRead;
    this.runtimeState.effectiveInputTokens += effectiveInput;
    this.runtimeState.contextTokens = effectiveInput;
    if (model) this.runtimeState.activeModel = model;
    this.runtimeState.contextLimit = inferredContextLimit(model || this.getSelectedModel(), this.configuredContextLimit());
    void this.publishRuntimeState();
  }

  async showModelPicker() {
    if (this.running) {
      this.post({ type: "notice", text: "Cancel the active response before changing models." });
      return;
    }

    let models = this.modelCatalog.models;
    let routes = this.modelCatalog.routes;
    let providers = this.modelCatalog.providers;
    let currentProvider = this.modelCatalog.currentProvider;
    let current = this.getSelectedModel();
    try {
      const client = await this.ensureSession();
      const [catalog, runtime] = await Promise.all([
        client.listModels(this.sessionId),
        client.getRuntimeInfo(this.sessionId).catch(() => undefined),
      ]);
      models = catalog.models.length > 0 ? catalog.models : this.getModelList();
      routes = runtime?.routes || [];
      providers = runtime?.providers || [];
      currentProvider = runtime?.provider;
      current = runtime?.model || catalog.current || current;
      this.modelCatalog = { models, routes, providers, currentProvider };
    } catch {
      // Keep the latest catalog so the picker remains useful while reconnecting.
    }

    const items = buildModelQuickPickItems(models, routes, current, currentProvider, providers);
    const picked = await vscode.window.showQuickPick(items, {
      title: "Select Jcode Model",
      placeHolder: "Search models by name or provider",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked && picked.model !== undefined) {
      await this.setSelectedModel(picked.model, false, picked.displayModel, picked.provider);
    }
  }

  post(message) {
    this.postChain = this.postChain.then(async () => {
      try {
        await this.view?.webview.postMessage(message);
      } catch (error) {
        log(`webview post failed: ${errorMessage(error)}`);
      }
    });
  }

  postBootstrap() {
    this.post({
      type: "bootstrap",
      selection: this.pendingSelection?.label,
      models: this.getModelList(),
      model: this.getSelectedModel(),
      effortLevels: EFFORT_LEVELS,
      effort: this.getSelectedEffort(),
      slashCommands: SLASH_COMMANDS.filter((command) => !command.hidden),
      attachments: [...this.attachments.values()].map(publicAttachment),
      runtimeState: this.runtimeState,
    });
  }

  async setSelectedModel(model, allowWhileRunning = false, displayModel = model, provider) {
    const value = typeof model === "string" ? model.trim() : "";
    const displayValue = typeof displayModel === "string" ? displayModel.trim() : value;
    const previous = this.getSelectedModel();
    if (this.running && !allowWhileRunning) {
      this.post({ type: "notice", text: "Cancel the active response before changing models." });
      this.post({ type: "options", model: previous });
      return false;
    }
    if (!value) {
      await this.context.workspaceState.update(CHAT_MODEL_KEY, undefined);
      await this.context.workspaceState.update(CHAT_MODEL_ROUTE_KEY, undefined);
      this.post({ type: "options", model: previous });
      this.post({ type: "notice", text: "Automatic model selection applies to the next new chat." });
      return true;
    }
    try {
      const client = await this.ensureSession();
      await client.setModel(this.sessionId, value);
      await this.context.workspaceState.update(CHAT_MODEL_KEY, displayValue);
      await this.context.workspaceState.update(CHAT_MODEL_ROUTE_KEY, value === displayValue ? undefined : value);
      this.modelCatalog.currentProvider = provider || this.modelCatalog.currentProvider;
      this.post({ type: "options", model: displayValue });
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
    const model = this.getSelectedModelRequest();
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
    log("restoreChat started");
    const selection = this.pendingSelection?.label;
    let sessionId;
    let models = [];
    let routes = [];
    let providers = [];
    let currentProvider;
    let current;
    let error;
    try {
      const client = await withTimeout(
        this.ensureSession(),
        45000,
        "restoring the Jcode session (bridge startup + handshake)",
      );
      log("ensureSession resolved");
      sessionId = this.sessionId;
      try {
        ({ models, current } = await client.listModels(sessionId));
      } catch {
        models = [];
      }
      try {
        const runtime = await client.getRuntimeInfo(sessionId);
        routes = runtime.routes || [];
        providers = runtime.providers || [];
        currentProvider = runtime.provider;
        current = runtime.model || current;
      } catch {
        routes = [];
      }
      this.modelCatalog = {
        models: models.length > 0 ? models : this.getModelList(),
        routes,
        providers,
        currentProvider,
      };
      this.runtimeState = this.loadRuntimeState(sessionId);
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
      slashCommands: SLASH_COMMANDS.filter((command) => !command.hidden),
      attachments: [...this.attachments.values()].map(publicAttachment),
      runtimeState: this.runtimeState,
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
        const changedRoute = event.model !== this.getSelectedModel()
          || (event.provider && this.modelCatalog.currentProvider && event.provider !== this.modelCatalog.currentProvider);
        void this.context.workspaceState.update(CHAT_MODEL_KEY, event.model);
        if (changedRoute) void this.context.workspaceState.update(CHAT_MODEL_ROUTE_KEY, undefined);
        this.modelCatalog.currentProvider = event.provider || this.modelCatalog.currentProvider;
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

      this.post({ type: "user", text: instruction, selection: selection?.label, attachments: attachments.public, turnId });
      this.post({ type: "sendAccepted", turnId });
      submitted = true;

      const contextParts = [instruction];
      const editorContext = this.editorContextSummary();
      if (editorContext) {
        contextParts.push(editorContext);
      }
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
        log(`chat send failed: ${message}`);
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
    const command = SLASH_COMMANDS.find((candidate) => candidate.name === rawName);
    if (!command || command.hidden) {
      return false;
    }

    if (name === "/cancel") {
      await this.cancel();
      this.post({ type: "notice", text: "Cancel requested." });
      return true;
    }
    if (name === "/help" || name === "/?" || name === "/commands") {
      this.post({ type: "commandHelp", commands: SLASH_COMMANDS.filter((candidate) => !candidate.hidden) });
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
          await this.showModelPicker();
        } catch (error) {
          this.post({ type: "error", text: `/model failed: ${errorMessage(error)}` });
        }
      } else {
        await this.setSelectedModel(argument);
      }
      return true;
    }
    if (name === "/effort") {
      if (!argument) this.post({ type: "openEffortPicker" });
      else if (EFFORT_LEVELS.includes(argument)) await this.setSelectedEffort(argument);
      else this.post({ type: "error", text: `Unknown effort ${JSON.stringify(argument)}. Use: ${EFFORT_LEVELS.join(", ")}.` });
      return true;
    }
    if (name === "/cls") {
      this.post({ type: "cleared" });
      return true;
    }
    if (name === "/save" || name === "/unsave") {
      return this.toggleBookmark(name === "/save" ? argument : undefined);
    }
    if (name === "/config") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "jcode");
      return true;
    }
    if (name === "/resume" || name === "/sessions" || name === "/session") {
      await this.openSessions();
      return true;
    }

    if (command.tier === "native") {
      return this.executeNativeSlash(name, argument);
    }
    if (command.tier === "prompt") {
      return this.executePromptSlash(name, argument);
    }
    if (command.tier === "cli") {
      return this.executeCliSlash(command);
    }
    if (command.tier === "terminal") {
      const terminal = openJcodeTerminal(this.context);
      const prefilled = (command.command || command.name) + (argument ? ` ${argument}` : "");
      terminal.sendText(prefilled, true);
      this.post({ type: "notice", text: `Opened the terminal agent with ${command.name}.` });
      return true;
    }
    return false;
  }

  async executeNativeSlash(name, argument) {
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
      } else if (name === "/rewind") {
        const index = Number.parseInt(argument, 10);
        if (!Number.isFinite(index) || index < 0) {
          this.post({ type: "error", text: "Usage: /rewind <message index>" });
        } else {
          await client.rewind(this.sessionId, index);
          this.post({ type: "notice", text: `Rewound to message ${index}. Use /rewind-undo to restore.` });
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
            ["Protocol", String(runtime.protocolVersion || "")],
          ],
        });
      } else if (name === "/context") {
        const history = await client.getHistory(this.sessionId);
        const rows = history.slice(-10).map((message) => [
          message.role || "?",
          String(message.content || message.text || "").slice(0, 80),
        ]);
        this.post({ type: "commandInfo", title: `Context (${history.length} messages)`, rows });
      }
      return true;
    } catch (error) {
      this.post({ type: "error", text: `${name} failed: ${errorMessage(error)}` });
      return true;
    }
  }

  async executePromptSlash(name, argument) {
    let promptText = PROMPT_COMMANDS[name];
    if (!promptText) return false;
    if (name === "/btw") {
      promptText = `${promptText} ${argument || ""}`.trim();
      if (!argument) {
        this.post({ type: "error", text: "Usage: /btw <question>" });
        return true;
      }
    } else if (argument) {
      promptText = `${promptText}\n\nRequest: ${argument}`;
    }
    return this.runSyntheticTurn(name, promptText);
  }

  async runSyntheticTurn(commandName, promptText) {
    const turnId = this.nextTurnId++;
    this.activeTurnId = turnId;
    this.running = true;
    this.cancelRequested = false;
    this.post({ type: "running", running: true, turnId });
    try {
      const selection = this.pendingSelection || await captureSelectionContext(this.context, false);
      this.pendingSelection = undefined;
      this.post({ type: "user", text: `${commandName} ${promptText.slice(0, 40)}…`, selection: selection?.label, attachments: [], turnId });
      this.post({ type: "sendAccepted", turnId });
      const result = await this.runTurn(promptText, [], turnId, undefined);
      if (!this.isTurnActive(turnId)) return undefined;
      this.post({
        type: "assistant",
        text: result.text || "Jcode completed without returning text.",
        provider: result.provider,
        model: result.model,
        turnId,
      });
      return true;
    } catch (error) {
      this.post({ type: "error", text: `${commandName} failed: ${errorMessage(error)}`, turnId });
      return true;
    } finally {
      if (this.activeTurnId === turnId) {
        this.running = false;
        this.cancelRequested = false;
        this.activeTurnId = undefined;
        this.post({ type: "running", running: false, turnId });
      }
    }
  }

  async executeCliSlash(command) {
    const executable = resolveJcodeExecutable(vscode.workspace.getConfiguration("jcode").get("executablePath", "jcode"));
    const args = [...command.cli];
    this.post({ type: "notice", text: `Running jcode ${args.join(" ")}…` });
    try {
      const output = await runJcodeCli(executable, args);
      const lines = output.trim().split("\n").filter(Boolean);
      this.post({
        type: "commandInfo",
        title: `jcode ${args.join(" ")}`,
        rows: lines.map((line) => ["", line]),
      });
    } catch (error) {
      this.post({ type: "error", text: `${command.name} failed: ${errorMessage(error)}` });
    }
    return true;
  }

  async openSessions() {
    try {
      const client = await getJcodeClient();
      const sessions = await client.listSessions();
      this.post({ type: "sessions", sessions, currentSessionId: this.sessionId });
    } catch (error) {
      this.post({ type: "error", text: `Could not list sessions: ${errorMessage(error)}` });
    }
  }

  async attachToSession(sessionId) {
    try {
      const client = await getJcodeClient();
      await client.attachSession(sessionId);
      this.sessionId = sessionId;
      this.sessionClient = client;
      this.sessionInitPromise = undefined;
      await this.context.workspaceState.update(CHAT_SESSION_KEY, sessionId);
      this.post({ type: "notice", text: `Attached to ${sessionId}.` });
      void this.restoreChat();
    } catch (error) {
      this.post({ type: "error", text: `Could not attach to session: ${errorMessage(error)}` });
    }
  }

  async renameCurrentSession(sessionId, title) {
    try {
      const client = await getJcodeClient();
      await client.renameSession(sessionId, title);
      this.post({ type: "notice", text: title ? `Session renamed to ${title}.` : "Session title cleared." });
    } catch (error) {
      this.post({ type: "error", text: `Could not rename session: ${errorMessage(error)}` });
    }
  }

  async toggleBookmark(label) {
    const bookmarks = new Map(this.context.workspaceState.get(CHAT_BOOKMARKS_KEY) || []);
    if (!this.sessionId) {
      try {
        await this.ensureSession();
      } catch (error) {
        this.post({ type: "error", text: `Could not bookmark the session: ${errorMessage(error)}` });
        return true;
      }
    }
    if (label) {
      bookmarks.set(this.sessionId, label);
      this.post({ type: "notice", text: `Session saved as "${label}".` });
    } else if (bookmarks.has(this.sessionId)) {
      bookmarks.delete(this.sessionId);
      this.post({ type: "notice", text: "Bookmark removed." });
    } else {
      bookmarks.set(this.sessionId, this.sessionId);
      this.post({ type: "notice", text: "Session saved." });
    }
    await this.context.workspaceState.update(CHAT_BOOKMARKS_KEY, [...bookmarks.entries()]);
    return true;
  }

  /**
   * Compact summary of the VS Code editor state, injected into each message
   * when `jcode.shareEditorContext` is enabled. The agent's session working
   * directory is the workspace root, so it can read these files itself.
   */
  editorContextSummary() {
    if (!vscode.workspace.getConfiguration("jcode").get("shareEditorContext", true)) {
      return undefined;
    }
    const parts = [];
    const editor = getCurrentTextEditor();
    if (editor?.document.uri.scheme === "file") {
      const file = editor.document.uri.fsPath;
      const selections = editor.selections.filter((selection) => !selection.isEmpty);
      const where = selections.length > 0
        ? ` (selection: ${selections.map(formatRange).join(", ")})`
        : "";
      parts.push(`active file: ${file}${where}${editor.document.isDirty ? " [dirty]" : ""}`);
    }
    const openFiles = vscode.workspace.textDocuments
      .filter((document) => document.uri.scheme === "file")
      .slice(0, 20)
      .map((document) => document.uri.fsPath);
    if (openFiles.length > 0) {
      const dirty = openFiles.filter((file) =>
        vscode.workspace.textDocuments.some(
          (document) => document.uri.scheme === "file" && document.uri.fsPath === file && document.isDirty,
        ),
      );
      parts.push(`open files (${openFiles.length}): ${openFiles.join(", ")}${dirty.length ? `; dirty: ${dirty.join(", ")}` : ""}`);
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      parts.push(`workspace root: ${workspaceRoot}`);
    }
    if (parts.length === 0) {
      return undefined;
    }
    return `VS Code context: ${parts.join(" | ")}`;
  }

  async runTurn(prompt, images = [], turnId, attachmentState) {
    const client = await this.ensureSession();
    if (!this.isTurnActive(turnId)) {
      throw cancelledError();
    }
    const sessionId = this.sessionId;
    let provider;
    let model;
    const toolInputs = new Map();
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
    const autoApprove = Boolean(vscode.workspace.getConfiguration("jcode").get("autoApprove", false));
    const result = await client.run(sessionId, prompt, {
      images,
      autoApprove,
      onEvent: (event) => {
        if (!this.isTurnActive(turnId)) return;
        switch (event.ev) {
          case "text_delta":
            this.post({ type: "delta", text: event.text, turnId, sessionId });
            break;
          case "reasoning_delta":
            this.post({ type: "reasoning", text: event.text, turnId, sessionId });
            break;
          case "tool_start":
            toolInputs.set(event.call_id, { name: event.name, input: "", captured: false });
            this.post({ type: "tool", kind: "start", name: event.name, detail: "", turnId });
            break;
          case "tool_input_delta": {
            const call = toolInputs.get(event.call_id) || { name: "", input: "", captured: false };
            call.input += event.delta || "";
            toolInputs.set(event.call_id, call);
            break;
          }
          case "tool_exec": {
            const call = toolInputs.get(event.call_id);
            if (call && isTodoToolName(event.name || call.name) && !call.captured) {
              try {
                this.updateRuntimeTodos(JSON.parse(call.input));
                call.captured = true;
              } catch {
                // Some providers finish streaming tool JSON only at tool_done.
              }
            }
            break;
          }
          case "tool_done":
            {
              const call = toolInputs.get(event.call_id);
              if (call && isTodoToolName(event.name || call.name) && !call.captured) {
                try {
                  this.updateRuntimeTodos(JSON.parse(call.input));
                } catch {
                  // Invalid or unavailable tool input cannot update the dashboard.
                }
              }
              toolInputs.delete(event.call_id);
            }
            this.post({ type: "tool", kind: "done", name: event.name, detail: event.output ? String(event.output).slice(0, 500) : "", error: Boolean(event.error), turnId });
            break;
          case "token_usage":
            this.updateRuntimeUsage(event, model);
            this.post({
              type: "usage",
              usage: {
                input: event.input,
                output: event.output,
                cacheReadInput: event.cache_read_input ?? event.cacheReadInput,
              },
              turnId,
            });
            break;
          case "model_info":
            if (event.model) {
              model = event.model;
              this.runtimeState.activeModel = event.model;
              this.runtimeState.contextLimit = inferredContextLimit(event.model, this.configuredContextLimit());
              void this.publishRuntimeState();
              this.post({ type: "options", model: event.model });
            }
            break;
          case "permission_request":
            this.post({
              type: "permission",
              requestId: event.request_id,
              toolName: event.tool_name,
              description: event.description,
              turnId,
            });
            break;
          default:
            break;
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
    } catch (error) {
      log(`cancel failed: ${errorMessage(error)}`);
    }
  }

  async newChat() {
    if (this.running) {
      await this.cancel();
    }
    this.sessionId = undefined;
    this.sessionClient = undefined;
    this.sessionInitPromise = undefined;
    this.attachments.clear();
    this.runtimeState = emptyRuntimeState(this.getSelectedModel(), this.configuredContextLimit());
    await this.context.workspaceState.update(CHAT_SESSION_KEY, undefined);
    this.post({ type: "cleared" });
    this.post({ type: "runtimeState", state: this.runtimeState });
    this.post({ type: "notice", text: "New chat. The next message creates a fresh session." });
  }

  dispose() {
    this.disposed = true;
  }
}

function publicAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    kind: attachment.kind,
    mediaType: attachment.mediaType,
  };
}

function runJcodeCli(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${stderr.trim() || stdout.trim() || `exit code ${code}`}`.slice(0, 500)));
      }
    });
  });
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
  const executable = resolveJcodeExecutable(config.get("executablePath", "jcode"));
  const configuredArguments = config.get("launchArguments", []);
  const cwd = getWorkingDirectory(editor);
  const args = cwd ? ["-C", cwd, ...configuredArguments] : configuredArguments;

  const model = context.workspaceState.get(CHAT_MODEL_ROUTE_KEY)
    || context.workspaceState.get(CHAT_MODEL_KEY)
    || config.get("defaultModel", "");
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

function getChatHtml(webview, context) {
  const nonce = getNonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "style.css"));
  const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "vendor", "marked.umd.js"));
  const purifyUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "vendor", "purify.min.js"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "chat.js"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <title>Jcode Chat</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <main class="app">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">J</span><span class="brand-copy"><span class="title">Jcode</span><small id="session-status">Connecting…</small></span></div>
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
      <section id="runtime-popover" class="runtime-popover" aria-label="Jcode agent status details" hidden>
        <div class="runtime-heading"><span>Agent status</span><span id="todo-summary" class="runtime-summary"></span></div>
        <div class="runtime-metrics">
          <div class="runtime-metric" title="Aggregate todo confidence"><div class="metric-label"><span>Confidence</span><strong id="confidence-value">—</strong></div><div class="metric-track"><i id="confidence-bar"></i></div></div>
          <div class="runtime-metric" title="Session KV cache read hit rate"><div class="metric-label"><span>KV cache</span><strong id="cache-value">—</strong></div><div class="metric-track"><i id="cache-bar"></i></div></div>
          <div class="runtime-metric" title="Latest observed prompt size versus the model context window"><div class="metric-label"><span>Context</span><strong id="context-value">—</strong></div><div class="metric-track"><i id="context-bar"></i></div></div>
        </div>
        <div id="todo-list" class="todo-list"></div>
      </section>
      <div id="selection" class="selection-chip" title=""><span>⌁</span><span id="selection-label"></span></div>
      <div class="composer">
        <div id="attachments" class="pending-attachments"></div>
        <textarea id="prompt" class="prompt" rows="3" aria-label="Message Jcode" placeholder="Ask Jcode… Type / for commands"></textarea>
        <div class="composer-tools">
          <div class="tool-left">
            <button id="attach" class="small-btn" type="button" title="Attach files or images"><svg viewBox="0 0 24 24"><path d="M12 17V7a4 4 0 0 1 8 0v9a7 7 0 0 1-14 0V6a2 2 0 0 1 4 0v10a3 3 0 0 0 6 0V8"/></svg><span>Attach</span></button>
            <button id="selection-toggle" class="small-btn active" type="button" title="Include current editor selection"><svg viewBox="0 0 24 24"><path d="M8 5H5v3M16 5h3v3M8 19H5v-3M16 19h3v-3M9 9h6v6H9z"/></svg><span>Selection</span></button>
            <div id="runtime-indicators" class="runtime-indicators" hidden>
              <button id="todo-indicator" class="runtime-indicator" type="button" aria-label="Show todos" title="Todos"><svg viewBox="0 0 16 16"><path d="M2.5 4.5 4 6l2.5-3M8 4.5h5M2.5 10 4 11.5l2.5-3M8 10h5"/></svg><span id="todo-count" class="indicator-badge"></span></button>
              <button id="confidence-indicator" class="runtime-indicator" type="button" aria-label="Show confidence" title="Confidence"><svg viewBox="0 0 16 16"><path d="m8 1.8 4.8 3.1v4.3c0 2.3-1.9 4-4.8 5-2.9-1-4.8-2.7-4.8-5V4.9L8 1.8Z"/><path d="m5.7 8 1.5 1.5 3.1-3.2"/></svg></button>
              <button id="cache-indicator" class="runtime-indicator" type="button" aria-label="Show KV cache rate" title="KV cache"><svg viewBox="0 0 16 16"><ellipse cx="8" cy="3.5" rx="4.8" ry="2"/><path d="M3.2 3.5v4c0 1.1 2.1 2 4.8 2s4.8-.9 4.8-2v-4M3.2 7.5v4c0 1.1 2.1 2 4.8 2s4.8-.9 4.8-2v-4"/></svg></button>
              <button id="context-indicator" class="runtime-indicator" type="button" aria-label="Show context usage" title="Context"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5V8l3.8 2.2"/></svg></button>
            </div>
          </div>
          <div class="tool-right">
            <button id="model" class="model-picker-button" type="button" aria-label="Select model" aria-haspopup="listbox" title="Select model"><span id="model-label">auto</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
            <select id="effort" class="effort-select" aria-label="Reasoning effort"></select>
            <button id="cancel" class="send-btn" type="button" title="Cancel response" aria-label="Cancel response"><svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1"/></svg></button>
            <button id="send" class="send-btn" type="button" title="Send message" aria-label="Send message"><svg viewBox="0 0 24 24"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg></button>
          </div>
        </div>
      </div>
      <div class="composer-hint">Enter to send · Shift+Enter for a new line · paste images directly</div>
    </footer>
  </main>
  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}" src="${purifyUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  return crypto.randomBytes(16).toString("base64").replace(/[+/=]/g, "");
}

function deactivate() {
  if (currentClient && !currentClient.closed) {
    void currentClient.close();
  }
}

module.exports = {
  activate,
  deactivate,
};
