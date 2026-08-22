// ACP client for jcode.
//
// The jcode CLI no longer ships `jcode api-bridge`. Its replacement for
// editor/IDE integration is `jcode acp`, an Agent Client Protocol (ACP) v1
// adapter that speaks JSON-RPC 2.0 over stdio. This module wraps that adapter
// in a client whose surface mirrors the old `@1jehuang/jcode-sdk` `JcodeClient`
// so the rest of the extension can keep its existing call sites.
//
// Reference: https://agentclientprotocol.com/protocol/v1/overview

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const ACP_PROTOCOL_VERSION = 1;

/** Resolve the jcode executable, honoring an explicit path or common installs. */
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
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable path; try the next candidate.
    }
  }
  return configured;
}

/** Absolute path to the jcode state directory (session persistence). */
function jcodeHome() {
  return process.env.JCODE_HOME || path.join(os.homedir(), ".jcode");
}

function sessionDir() {
  return path.join(jcodeHome(), "sessions");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extract the human-readable text from a jcode session message, whose `content`
 * is an array of blocks ({type:"text"}, {type:"tool_use"}, {type:"tool_result"}).
 */
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(`[tool: ${block.name || "tool"}]`);
    }
  }
  return parts.join("\n");
}

class AcpClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.executable Resolved jcode binary path.
   * @param {string[]} [options.args] Extra arguments before `acp`.
   * @param {string} [options.clientName] Name reported during initialize.
   * @param {(line: string) => void} [options.log] Diagnostic logger.
   */
  constructor(options) {
    super();
    this.executable = options.executable || "jcode";
    this.args = Array.isArray(options.args) ? options.args : [];
    this.clientName = options.clientName || "jcode-vscode";
    this.log = options.log || (() => {});
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.agentInfo = undefined;
    this.agentCapabilities = undefined;
    this.autoApprove = false;
    this.onPermissionRequest = undefined;
    // Per-session state: configOptions (model/effort) and the model catalog.
    this.sessionState = new Map();
    // History captured during session/load replays, keyed by session id.
    this.sessionHistory = new Map();
    this._buffer = "";
    this._child = undefined;
    this._initialized = false;
    this._initPromise = undefined;
  }

  static async connect(options) {
    const client = new AcpClient(options);
    await client.initialize();
    return client;
  }

  async initialize() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._start().catch((error) => {
      this._initPromise = undefined;
      this._teardown();
      throw error;
    });
    return this._initPromise;
  }

  async _start() {
    const args = [...this.args, "--no-update", "--no-selfdev", "acp"];
    this.log(`starting jcode acp: ${this.executable} ${args.join(" ")}`);
    const child = spawn(this.executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this._child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log(`acp stderr: ${text}`);
    });
    child.on("error", (error) => {
      this.log(`acp spawn error: ${errorMessage(error)}`);
    });
    child.on("exit", (code, signal) => {
      this.log(`acp exited: code=${code} signal=${signal}`);
      this.closed = true;
      this._rejectAll(new Error(`The jcode acp process exited (code=${code}).`));
      this.emit("close");
    });

    const result = await this._request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        session: { configOptions: { boolean: {} } },
      },
      clientInfo: {
        name: "jcode-vscode",
        title: "Jcode for VS Code",
        version: this.clientName.split("/")[1] || "0.0.0",
      },
    });
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `Unsupported ACP protocol version ${result.protocolVersion} (expected ${ACP_PROTOCOL_VERSION}).`,
      );
    }
    this.agentCapabilities = result.agentCapabilities || {};
    this.agentInfo = result.agentInfo || {};
    this._initialized = true;
    this.log(
      `acp initialized (agent=${this.agentInfo.name} ${this.agentInfo.version}, protocol=${result.protocolVersion})`,
    );
    return this;
  }

  _onStdout(chunk) {
    this._buffer += chunk;
    let index;
    while ((index = this._buffer.indexOf("\n")) >= 0) {
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.log(`acp non-JSON line: ${line.slice(0, 200)}`);
        continue;
      }
      this._route(message);
    }
  }

  _route(message) {
    if (message && typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        // Incoming request from the agent (e.g. session/request_permission).
        this._handleIncomingRequest(message);
      } else {
        this._handleNotification(message);
      }
      return;
    }
    if (message && message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "ACP request failed");
        error.code = message.error.code;
        error.data = message.error.data;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
    }
  }

  _request(method, params) {
    if (this.closed) {
      return Promise.reject(new Error("The jcode acp client is closed."));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this._child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  _notify(method, params) {
    if (this.closed) return;
    this._child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  _handleIncomingRequest(message) {
    if (message.method === "session/request_permission") {
      this._handlePermissionRequest(message);
      return;
    }
    // Unknown incoming request: respond with a method-not-found error so the
    // agent is not left waiting on an unanswered request.
    if (message.id !== undefined) {
      this._child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        }) + "\n",
      );
    }
  }

  _handlePermissionRequest(message) {
    const params = message.params || {};
    const toolCall = params.toolCall || {};
    const options = Array.isArray(params.options) ? params.options : [];
    const toolName = toolCall.title || toolCall.rawInput?.name || "tool";
    const description = toolCall.title || toolCall.rawInput?.command || "";
    const allowOption =
      options.find((option) => option.kind === "allow_once" || option.kind === "allow_always") ||
      options.find((option) => !option.kind || option.kind === "allow_once") ||
      options[0];
    const rejectOption =
      options.find((option) => option.kind === "reject_once" || option.kind === "reject_always") ||
      options.find((option) => option.kind === "reject_once");

    const respond = (outcome) => {
      if (this.closed) return;
      this._child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome } }) + "\n",
      );
    };

    if (this.autoApprove) {
      respond(allowOption ? { outcome: "selected", optionId: allowOption.optionId } : { outcome: "cancelled" });
      return;
    }

    const request = {
      request_id: String(message.id),
      tool_name: toolName,
      description,
      respond: (decision) => {
        if (decision === "allow") {
          respond(allowOption ? { outcome: "selected", optionId: allowOption.optionId } : { outcome: "cancelled" });
        } else {
          respond(rejectOption ? { outcome: "selected", optionId: rejectOption.optionId } : { outcome: "cancelled" });
        }
      },
    };
    if (typeof this.onPermissionRequest === "function") {
      void Promise.resolve(this.onPermissionRequest(request)).catch((error) => {
        this.log(`permission handler error: ${errorMessage(error)}`);
        request.respond("deny");
      });
    } else {
      // No handler and not auto-approving: deny to avoid hanging the turn.
      request.respond("deny");
    }
  }

  _handleNotification(message) {
    if (message.method !== "session/update") return;
    const params = message.params || {};
    const update = params.update || {};
    const sessionId = params.sessionId;
    const kind = update.sessionUpdate;

    switch (kind) {
      case "config_option_update":
        this._cacheConfigOptions(sessionId, update.configOptions);
        this._emitModelInfo(sessionId, update.configOptions);
        break;
      case "session_info_update":
        break;
      case "available_commands_update":
        break;
      default:
        break;
    }
    this.emit("update", { sessionId, update });
  }

  _cacheConfigOptions(sessionId, configOptions) {
    if (!sessionId) return;
    const state = this.sessionState.get(sessionId) || {};
    state.configOptions = Array.isArray(configOptions) ? configOptions : state.configOptions;
    this.sessionState.set(sessionId, state);
  }

  _cacheModels(sessionId, models) {
    if (!sessionId || !models) return;
    const state = this.sessionState.get(sessionId) || {};
    state.models = models;
    this.sessionState.set(sessionId, state);
  }

  _currentModel(sessionId) {
    const state = this.sessionState.get(sessionId);
    if (!state) return undefined;
    const modelOption = (state.configOptions || []).find((option) => option.id === "model");
    if (modelOption?.currentValue) return String(modelOption.currentValue);
    return state.models?.currentModelId;
  }

  _emitModelInfo(sessionId, configOptions) {
    const modelOption = (configOptions || []).find((option) => option.id === "model");
    if (modelOption?.currentValue) {
      this.emit("model_info", {
        session_id: sessionId,
        model: String(modelOption.currentValue),
      });
    }
  }

  _rejectAll(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  _teardown() {
    this.closed = true;
    this._rejectAll(new Error("The jcode acp client is closed."));
    if (this._child && !this._child.killed) {
      try {
        this._child.kill();
      } catch {
        // Process already gone.
      }
    }
    this.emit("close");
  }

  // ---- Session lifecycle -------------------------------------------------

  async createSession(workingDir) {
    await this.initialize();
    const result = await this._request("session/new", {
      cwd: workingDir,
      mcpServers: [],
    });
    const sessionId = result.sessionId;
    if (sessionId) {
      this._cacheConfigOptions(sessionId, result.configOptions);
      this._cacheModels(sessionId, result.models);
    }
    return { session_id: sessionId };
  }

  async attachSession(sessionId) {
    await this.initialize();
    const result = await this._request("session/load", {
      sessionId,
      cwd: await this._sessionWorkingDir(sessionId),
      mcpServers: [],
    });
    this._cacheConfigOptions(sessionId, result.configOptions);
    return result;
  }

  async resumeSession(sessionId) {
    await this.initialize();
    const result = await this._request("session/resume", {
      sessionId,
      cwd: await this._sessionWorkingDir(sessionId),
      mcpServers: [],
    });
    this._cacheConfigOptions(sessionId, result.configOptions);
    return result;
  }

  async closeSession(sessionId) {
    if (this.closed) return;
    try {
      await this._request("session/close", { sessionId });
    } catch (error) {
      this.log(`session/close failed: ${errorMessage(error)}`);
    }
  }

  /** Kill the acp process and free resources. */
  async close() {
    if (this.closed) return;
    this._teardown();
  }

  async _sessionWorkingDir(sessionId) {
    const meta = await readSessionMeta(sessionId);
    return meta?.working_dir || process.cwd();
  }

  // ---- Session discovery / history (from persisted state) ----------------

  async listSessions() {
    const directory = sessionDir();
    let entries = [];
    try {
      entries = await fs.readdir(directory);
    } catch {
      return [];
    }
    const sessions = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(directory, name);
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8"));
        if (!raw?.id) continue;
        sessions.push({
          session_id: raw.id,
          title: raw.title || undefined,
          working_dir: raw.working_dir || undefined,
          status: raw.status || undefined,
          model: raw.model || undefined,
          provider: raw.provider_key || undefined,
          updated_at: raw.updated_at || raw.last_active_at || undefined,
        });
      } catch {
        // Skip unreadable session files.
      }
    }
    sessions.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return sessions;
  }

  async getHistory(sessionId) {
    const cached = this.sessionHistory.get(sessionId);
    if (cached) return cached;
    const meta = await readSessionMeta(sessionId);
    return (meta?.messages || []).map(toHistoryMessage);
  }

  async peekSession(sessionId, limit) {
    const history = await this.getHistory(sessionId);
    const count = Number.isFinite(limit) && limit > 0 ? limit : 1;
    return history.slice(-count);
  }

  // ---- Model / reasoning effort ------------------------------------------

  async listModels(sessionId) {
    const state = this.sessionState.get(sessionId);
    const models = state?.models;
    if (models) {
      return {
        models: (models.availableModels || []).map((model) => model.modelId || model.name).filter(Boolean),
        current: models.currentModelId,
      };
    }
    const modelOption = (state?.configOptions || []).find((option) => option.id === "model");
    if (modelOption) {
      return {
        models: (modelOption.options || []).map((option) => option.value).filter(Boolean),
        current: modelOption.currentValue,
      };
    }
    return { models: [], current: undefined };
  }

  async setModel(sessionId, model) {
    const result = await this._request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: model,
    });
    this._cacheConfigOptions(sessionId, result.configOptions);
    return result;
  }

  async setReasoningEffort(sessionId, effort) {
    const result = await this._request("session/set_config_option", {
      sessionId,
      configId: "reasoning_effort",
      value: effort,
    });
    this._cacheConfigOptions(sessionId, result.configOptions);
    return result;
  }

  async getRuntimeInfo(sessionId) {
    const model = this._currentModel(sessionId);
    return {
      server: this.agentInfo?.name || "jcode",
      version: this.agentInfo?.version || "",
      protocolVersion: ACP_PROTOCOL_VERSION,
      provider: undefined,
      model,
      routes: [],
      providers: [],
      healthy: !this.closed,
    };
  }

  // ---- Prompt turn --------------------------------------------------------

  async run(sessionId, prompt, options = {}) {
    await this.initialize();
    const images = Array.isArray(options.images) ? options.images : [];
    const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    if (options.autoApprove !== undefined) {
      this.autoApprove = Boolean(options.autoApprove);
    }

    const blocks = [{ type: "text", text: prompt }];
    for (const image of images) {
      const [mimeType, data] = Array.isArray(image) ? image : [];
      if (mimeType && data) blocks.push({ type: "image", mimeType, data });
    }

    let text = "";
    const toolNames = new Map();
    const toolInputEmitted = new Set();
    const isTodoPayload = (input) =>
      input && typeof input === "object" && ("todos" in input || "goals" in input || "plan" in input);
    const toolNameFor = (update, fallback) => {
      const rawInput = update.rawInput;
      return isTodoPayload(rawInput)
        ? "todo"
        : update.title || rawInput?.name || toolNames.get(update.toolCallId) || fallback || "tool";
    };
    const onUpdate = (update) => {
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const content = update.content || {};
          const chunk = typeof content.text === "string" ? content.text : "";
          if (chunk) {
            text += chunk;
            onEvent({ ev: "text_delta", text: chunk });
          }
          break;
        }
        case "agent_thought_chunk":
        case "thought_message_chunk": {
          const content = update.content || {};
          const chunk = typeof content.text === "string" ? content.text : "";
          if (chunk) onEvent({ ev: "reasoning_delta", text: chunk });
          break;
        }
        case "tool_call": {
          toolNames.set(update.toolCallId, update.title || "");
          onEvent({
            ev: "tool_start",
            call_id: update.toolCallId,
            name: toolNameFor(update, ""),
            detail: "",
          });
          break;
        }
        case "tool_call_update": {
          const callId = update.toolCallId;
          const name = toolNameFor(update, "");
          // The ACP wire has no tool_input_delta; surface a tool's raw input
          // (which for the todo tool is the todo/goal JSON) once so the
          // extension's todo dashboard can capture it.
          const rawInput = update.rawInput;
          if (rawInput && typeof rawInput === "object" && Object.keys(rawInput).length > 0 && !toolInputEmitted.has(callId)) {
            toolInputEmitted.add(callId);
            onEvent({ ev: "tool_input_delta", call_id: callId, delta: JSON.stringify(rawInput) });
          }
          if (update.status === "in_progress") {
            onEvent({ ev: "tool_exec", call_id: callId, name });
          } else if (update.status === "completed" || update.status === "failed") {
            const output = toolOutputText(update);
            onEvent({
              ev: "tool_done",
              call_id: callId,
              name,
              output,
              error: update.status === "failed" ? true : Boolean(update.rawOutput?.error),
            });
            toolNames.delete(callId);
          }
          break;
        }
        case "usage_update": {
          onEvent({
            ev: "token_usage",
            input: update.used || 0,
            output: 0,
            cache_read_input: 0,
          });
          break;
        }
        default:
          break;
      }
    };

    const handler = ({ sessionId: updateSessionId, update }) => {
      if (updateSessionId !== sessionId) return;
      onUpdate(update);
    };
    this.on("update", handler);
    try {
      const result = await this._request("session/prompt", { sessionId, prompt: blocks });
      const usage = result.usage || {};
      if (usage.inputTokens || usage.outputTokens || usage.cachedReadTokens) {
        onEvent({
          ev: "token_usage",
          input: usage.inputTokens || 0,
          output: usage.outputTokens || 0,
          cache_read_input: usage.cachedReadTokens || 0,
        });
      }
      return { text, stop_reason: result.stopReason };
    } finally {
      this.off("update", handler);
    }
  }

  async cancel(sessionId) {
    this._notify("session/cancel", { sessionId });
  }

  // ---- Operations without a dedicated ACP method: send the TUI slash
  // command as a prompt turn. jcode recognizes the command prefix. ----------

  async _runSlashCommand(sessionId, command) {
    return this.run(sessionId, command, {});
  }

  async clear(sessionId) {
    return this._runSlashCommand(sessionId, "/clear");
  }

  async compact(sessionId) {
    return this._runSlashCommand(sessionId, "/compact");
  }

  async rewind(sessionId, index) {
    return this._runSlashCommand(sessionId, `/rewind ${index}`);
  }

  async softInterrupt(sessionId, text) {
    // ACP has no mid-turn soft interrupt; inject as a steering message only if
    // the agent exposes it. Best-effort: return without changing the turn.
    this.log(`soft interrupt is not supported over ACP (${sessionId}): ${text}`);
    return undefined;
  }

  async renameSession(sessionId, title) {
    // jcode persists session titles; there is no ACP method for rename, so use
    // the CLI. Fall back gracefully when the CLI is unavailable.
    return runJcodeCli(this.executable, ["session", "rename", sessionId, title]);
  }
}

function toolOutputText(update) {
  const rawOutput = update.rawOutput;
  if (rawOutput && typeof rawOutput === "object") {
    if (typeof rawOutput.output === "string" && rawOutput.output) return rawOutput.output;
    if (rawOutput.error) return String(rawOutput.error);
  }
  const content = Array.isArray(update.content) ? update.content : [];
  const parts = [];
  for (const item of content) {
    if (item?.type === "content" && item.content?.type === "text" && typeof item.content.text === "string") {
      parts.push(item.content.text);
    }
  }
  return parts.join("\n");
}

function toHistoryMessage(message) {
  const role = ["user", "assistant", "tool"].includes(message.role) ? message.role : "assistant";
  const text = messageText(message.content);
  return { role, content: text, text };
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
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || `exit code ${code}`).trim().slice(0, 500)));
    });
  });
}

async function readSessionMeta(sessionId) {
  if (!sessionId) return undefined;
  const file = path.join(sessionDir(), `${sessionId}.json`);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

module.exports = {
  AcpClient,
  resolveJcodeExecutable,
  jcodeHome,
  sessionDir,
  messageText,
};
