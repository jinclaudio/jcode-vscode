const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const vscode = require("vscode");

const TASKS_KEY = "jcode.multiSession.tasks";
const MAX_TASKS = 50;
const MAX_OUTPUT = 16000;
class MultiSessionTaskManager {
  constructor(options) {
    this.context = options.context;
    this.getClient = options.getClient;
    this.createClient = options.createClient || options.getClient;
    this.post = options.post;
    this.getWorkspaceRoot = options.getWorkspaceRoot;
    this.log = options.log || (() => {});
    this.openSession = options.openSession;
    this.tasks = new Map();
    this.running = new Map();
    this.repoLocks = new Map();
    this.initialized = false;
    this.scheduling = false;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    const saved = this.context.workspaceState.get(TASKS_KEY, []);
    for (const raw of Array.isArray(saved) ? saved.slice(-MAX_TASKS) : []) {
      if (!raw || typeof raw.id !== "string") continue;
      const task = { ...raw };
      if (task.status === "running") task.status = "detached";
      this.tasks.set(task.id, task);
    }
    await this.syncDetachedTasks();
    this.publish();
    void this.schedule();
  }

  config() {
    return vscode.workspace.getConfiguration("jcode.multiSession");
  }

  maxConcurrent() {
    return Math.max(1, Math.min(12, Number(this.config().get("maxConcurrent", 3)) || 3));
  }

  enabled() {
    return Boolean(this.config().get("enabled", true));
  }

  snapshot() {
    return [...this.tasks.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((task) => publicTask(task));
  }

  getTask(id) {
    return this.tasks.get(id);
  }

  async createTask(input = {}) {
    await this.initialize();
    if (!this.enabled()) throw new Error("Multi-session tasks are disabled in Jcode settings.");
    if (this.tasks.size >= MAX_TASKS) throw new Error(`The task dashboard is limited to ${MAX_TASKS} tasks. Remove completed tasks before creating another.`);
    const title = String(input.title || "").trim();
    const prompt = String(input.prompt || "").trim();
    if (!title || !prompt) throw new Error("Task title and prompt are required.");
    const root = this.getWorkspaceRoot();
    if (!root) throw new Error("Open a workspace folder before creating a task.");
    const kind = input.kind === "coordinator" ? "coordinator" : "task";
    const requestedMode = String(input.mode || this.config().get("defaultIsolation", "worktree"));
    const selectedMode = ["worktree", "shared", "read-only"].includes(requestedMode) ? requestedMode : "worktree";
    const mode = kind === "coordinator" ? "read-only" : selectedMode;
    const id = `task-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const task = {
      id,
      title,
      prompt,
      kind,
      mode,
      status: "preparing",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dependsOn: normalizeDependencies(input.dependsOn, this.tasks),
      model: String(input.model || "").trim(),
      effort: String(input.effort || "").trim(),
      output: "",
      summary: "",
      error: undefined,
      workingDir: root,
      repoRoot: root,
      branch: undefined,
      baseCommit: undefined,
      commit: undefined,
      sessionId: undefined,
      cancelRequested: false,
      autoCommit: input.autoCommit !== undefined
        ? Boolean(input.autoCommit)
        : Boolean(this.config().get("autoCommit", true)),
    };
    this.tasks.set(id, task);
    this.publish();
    try {
      if (mode === "worktree") await this.prepareWorktree(task);
      task.status = "queued";
      task.updatedAt = Date.now();
      await this.persist();
      this.publish();
      void this.schedule();
      return publicTask(task);
    } catch (error) {
      task.status = "failed";
      task.error = errorMessage(error);
      task.updatedAt = Date.now();
      await this.persist();
      this.publish();
      throw error;
    }
  }

  async createBatch(items) {
    const created = [];
    for (const item of Array.isArray(items) ? items : []) {
      created.push(await this.createTask(item));
    }
    return created;
  }

  async prepareWorktree(task) {
    const repoRoot = (await runGit(task.repoRoot, ["rev-parse", "--show-toplevel"])).trim();
    const baseCommit = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
    const slug = slugify(task.title).slice(0, 34) || "task";
    const branch = `jcode/${slug}-${task.id.slice(-6)}`;
    const repoHash = crypto.createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
    const parent = path.join(this.context.globalStorageUri.fsPath, "worktrees", repoHash);
    const workingDir = path.join(parent, task.id);
    await fs.mkdir(parent, { recursive: true });
    await runGit(repoRoot, ["worktree", "add", "-b", branch, workingDir, baseCommit], { timeout: 120000 });
    task.repoRoot = repoRoot;
    task.workingDir = workingDir;
    task.branch = branch;
    task.baseCommit = baseCommit;
  }

  dependencyState(task) {
    const dependencies = task.dependsOn.map((id) => this.tasks.get(id)).filter(Boolean);
    if (dependencies.some((dependency) => ["failed", "cancelled", "blocked"].includes(dependency.status))) {
      return "blocked";
    }
    return dependencies.every((dependency) => ["completed", "merged"].includes(dependency.status)) ? "ready" : "waiting";
  }

  async schedule() {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      let available = this.maxConcurrent() - this.running.size;
      for (const task of this.tasks.values()) {
        if (task.status !== "queued" || available <= 0) continue;
        const dependencyState = this.dependencyState(task);
        if (dependencyState === "blocked") {
          task.status = "blocked";
          task.error = "A dependency failed or was cancelled.";
          task.updatedAt = Date.now();
          continue;
        }
        if (dependencyState !== "ready") continue;
        available -= 1;
        void this.runTask(task);
      }
      await this.persist();
      this.publish();
    } finally {
      this.scheduling = false;
    }
  }

  async runTask(task) {
    task.status = "running";
    task.startedAt = Date.now();
    task.updatedAt = Date.now();
    task.error = undefined;
    task.cancelRequested = false;
    const runState = { client: undefined };
    this.running.set(task.id, runState);
    await this.persist();
    this.publish();
    try {
      const client = await this.createClient();
      runState.client = client;
      if (!task.sessionId) {
        const session = await client.createSession(task.workingDir);
        task.sessionId = session.session_id;
        try { await client.renameSession(task.sessionId, task.title); } catch {}
      } else {
        await client.attachSession(task.sessionId);
      }
      if (task.model) await client.setModel(task.sessionId, task.model);
      if (task.effort) await client.setReasoningEffort(task.sessionId, task.effort);
      if (task.cancelRequested) {
        task.status = "cancelled";
        return;
      }
      const prompt = this.buildPrompt(task);
      const result = await client.run(task.sessionId, prompt, {
        autoApprove: Boolean(vscode.workspace.getConfiguration("jcode").get("autoApprove", false)),
        onEvent: (event) => this.handleEvent(task, event),
      });
      if (task.cancelRequested) {
        task.status = "cancelled";
      } else {
        task.summary = result.text || task.output || "Task completed.";
        task.status = "completed";
        if (task.mode === "worktree" && task.autoCommit) {
          task.commit = await this.commitTask(task.id, false);
        }
      }
    } catch (error) {
      if (task.cancelRequested || error?.cancelled) {
        task.status = "cancelled";
      } else {
        task.status = "failed";
        task.error = errorMessage(error);
      }
    } finally {
      const client = runState.client;
      if (client && typeof client.close === "function") {
        try { await client.close(); } catch (error) {
          this.log(`parallel task client close failed: ${errorMessage(error)}`);
        }
      }
      this.running.delete(task.id);
      task.finishedAt = Date.now();
      task.updatedAt = Date.now();
      await this.persist();
      this.publish();
      void this.schedule();
    }
  }

  buildPrompt(task) {
    const dependencyText = task.dependsOn.map((id) => this.tasks.get(id)).filter(Boolean).map((dependency) => {
      const result = dependency.summary || dependency.output || dependency.error || dependency.status;
      return `- ${dependency.title} (${dependency.status}): ${String(result).slice(0, 4000)}`;
    });
    const rules = [
      `You are working on the assigned task ${JSON.stringify(task.title)}.`,
      `Your working directory is ${JSON.stringify(task.workingDir)}.`,
    ];
    if (task.mode === "read-only" || task.kind === "coordinator") {
      rules.push("Do not modify files. Return a concrete result and cite relevant paths.");
    } else if (task.mode === "worktree") {
      rules.push("This is an isolated Git worktree. Make the requested changes and validate them. Do not edit the main worktree.");
    } else {
      rules.push("This working directory may be shared with other tasks. Avoid unrelated files and report every file you change.");
    }
    if (task.kind === "coordinator") {
      rules.push("Act as coordinator: synthesize dependency results, identify conflicts or gaps, and provide a final integration plan. Do not redo completed implementation work.");
    }
    if (dependencyText.length) rules.push(`Dependency results:\n${dependencyText.join("\n")}`);
    rules.push(`Task:\n${task.prompt}`);
    return rules.join("\n\n");
  }

  handleEvent(task, event) {
    if (event.ev === "text_delta" || event.ev === "reasoning_delta") {
      task.output = appendBounded(task.output, event.text || "", MAX_OUTPUT);
    } else if (event.ev === "tool_start") {
      task.activity = `Using ${event.name || "tool"}`;
    } else if (event.ev === "tool_done") {
      task.activity = event.error ? `${event.name || "Tool"} failed` : `${event.name || "Tool"} completed`;
    } else if (event.ev === "token_usage") {
      task.usage = {
        input: event.input || 0,
        output: event.output || 0,
        cacheReadInput: event.cache_read_input ?? event.cacheReadInput ?? 0,
      };
    } else if (event.ev === "model_info") {
      task.activeModel = event.model || task.activeModel;
      task.provider = event.provider || task.provider;
    }
    task.updatedAt = Date.now();
    this.publish();
  }

  async cancelTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Task not found.");
    if (task.status === "queued" || task.status === "preparing") {
      task.status = "cancelled";
      task.cancelRequested = true;
      task.updatedAt = Date.now();
      await this.persist();
      this.publish();
      void this.schedule();
      return;
    }
    if (task.status === "detached") {
      task.cancelRequested = true;
      const client = await this.createClient();
      try {
        if (task.sessionId) await client.cancel(task.sessionId);
        task.status = "cancelled";
        task.updatedAt = Date.now();
        await this.persist();
        this.publish();
        void this.schedule();
      } finally {
        if (typeof client.close === "function") await client.close();
      }
      return;
    }
    if (task.status !== "running") return;
    task.cancelRequested = true;
    const client = this.running.get(id)?.client;
    if (client && task.sessionId) await client.cancel(task.sessionId);
    this.publish();
  }

  async openTask(id) {
    const task = this.tasks.get(id);
    if (!task?.sessionId) throw new Error("This task has not created a session yet.");
    if (task.status === "running") throw new Error("Wait for the task to finish or cancel it before opening its session in Chat.");
    await this.openSession(task.sessionId);
  }

  async showDiff(id) {
    const task = this.requireWorktreeTask(id);
    const committed = await runGit(task.workingDir, ["diff", "--no-ext-diff", `${task.baseCommit}...HEAD`], { allowExitCodes: [0, 1] });
    const uncommitted = await runGit(task.workingDir, ["diff", "--no-ext-diff", "HEAD"], { allowExitCodes: [0, 1] });
    const untrackedNames = await runGit(task.workingDir, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const untrackedDiffs = [];
    for (const file of untrackedNames.split("\0").filter(Boolean).slice(0, 100)) {
      untrackedDiffs.push(await runGit(task.workingDir, ["diff", "--no-index", "--", "/dev/null", file], { allowExitCodes: [0, 1] }));
    }
    const content = [committed, uncommitted, ...untrackedDiffs].filter(Boolean).join("\n");
    const document = await vscode.workspace.openTextDocument({ language: "diff", content: content || "No changes." });
    await vscode.window.showTextDocument(document, { preview: true });
    return content;
  }

  async commitTask(id, notify = true) {
    const task = this.requireWorktreeTask(id);
    const status = (await runGit(task.workingDir, ["status", "--porcelain"])).trim();
    if (!status) {
      const head = (await runGit(task.workingDir, ["rev-parse", "HEAD"])).trim();
      task.commit = head === task.baseCommit ? undefined : head;
      if (notify) void vscode.window.showInformationMessage("Task worktree has no uncommitted changes.");
      return task.commit;
    }
    await runGit(task.workingDir, ["add", "-A"]);
    await runGit(task.workingDir, ["commit", "-m", `task: ${task.title}`], { timeout: 120000 });
    task.commit = (await runGit(task.workingDir, ["rev-parse", "HEAD"])).trim();
    task.updatedAt = Date.now();
    await this.persist();
    this.publish();
    if (notify) void vscode.window.showInformationMessage(`Committed task ${task.title}.`);
    return task.commit;
  }

  async mergeTask(id) {
    const task = this.requireWorktreeTask(id);
    if (task.status !== "completed") throw new Error("Only successfully completed tasks can be merged.");
    return this.withRepoLock(task.repoRoot, async () => {
      await this.commitTask(id, false);
      const mainStatus = (await runGit(task.repoRoot, ["status", "--porcelain"])).trim();
      if (mainStatus) throw new Error("The main worktree has uncommitted changes. Commit or stash them before merging a task.");
      const commitsText = (await runGit(task.repoRoot, ["rev-list", "--reverse", `${task.baseCommit}..${task.branch}`])).trim();
      const commits = commitsText ? commitsText.split(/\s+/) : [];
      if (!commits.length) throw new Error("The task has no commits to merge.");
      try {
        await runGit(task.repoRoot, ["cherry-pick", ...commits], { timeout: 180000 });
      } catch (error) {
        try { await runGit(task.repoRoot, ["cherry-pick", "--abort"]); } catch {}
        throw new Error(`Task merge conflicted and was aborted: ${errorMessage(error)}`);
      }
      task.status = "merged";
      task.mergedAt = Date.now();
      task.updatedAt = Date.now();
      await this.persist();
      this.publish();
      return commits;
    });
  }

  async withRepoLock(repoRoot, operation) {
    const previous = this.repoLocks.get(repoRoot) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.repoLocks.set(repoRoot, current);
    try {
      return await current;
    } finally {
      if (this.repoLocks.get(repoRoot) === current) this.repoLocks.delete(repoRoot);
    }
  }

  async removeTask(id, force = false) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status === "running") throw new Error("Cancel the running task before removing it.");
    if (task.status === "detached") throw new Error("Cancel the detached task before removing it.");
    if (task.mode === "worktree" && task.workingDir) {
      const dirty = (await runGit(task.workingDir, ["status", "--porcelain"])).trim();
      if (dirty && !force) throw new Error("The task worktree has uncommitted changes.");
      await runGit(task.repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), task.workingDir], { timeout: 120000 });
    }
    this.tasks.delete(id);
    await this.persist();
    this.publish();
    void this.schedule();
  }

  requireWorktreeTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Task not found.");
    if (task.mode !== "worktree" || !task.workingDir || !task.baseCommit) {
      throw new Error("This operation requires a worktree-isolated task.");
    }
    return task;
  }

  async syncDetachedTasks() {
    const detached = [...this.tasks.values()].filter((task) => task.status === "detached" && task.sessionId);
    if (!detached.length) return;
    try {
      const client = await this.getClient();
      const sessions = await client.listSessions();
      const byId = new Map(sessions.map((session) => [session.session_id, session]));
      for (const task of detached) {
        const session = byId.get(task.sessionId);
        if (!session) {
          task.status = "failed";
          task.error = "The Jcode session no longer exists.";
        } else if (session.status === "running") {
          task.status = "detached";
        } else {
          try {
            const history = await client.peekSession(task.sessionId, 1);
            const last = Array.isArray(history) ? history.at(-1) : undefined;
            task.summary = last?.content || last?.text || task.summary;
          } catch {}
          task.status = "completed";
        }
      }
      await this.persist();
    } catch (error) {
      this.log(`multi-session restore failed: ${errorMessage(error)}`);
    }
  }

  publish() {
    this.post({
      type: "tasks",
      enabled: this.enabled(),
      tasks: this.snapshot(),
      maxConcurrent: this.maxConcurrent(),
      defaultIsolation: this.config().get("defaultIsolation", "worktree"),
      autoCommit: Boolean(this.config().get("autoCommit", true)),
    });
  }

  async persist() {
    const tasks = [...this.tasks.values()].slice(-MAX_TASKS).map((task) => {
      const copy = { ...task };
      delete copy.cancelRequested;
      return copy;
    });
    await this.context.workspaceState.update(TASKS_KEY, tasks);
  }

  dispose() {
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.cancelRequested = true;
      const client = this.running.get(task.id)?.client;
      if (client && task.sessionId) {
        void client.cancel(task.sessionId)
          .catch((error) => this.log(`multi-session dispose cancellation failed: ${errorMessage(error)}`));
      }
    }
  }
}

function publicTask(task) {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    kind: task.kind,
    mode: task.mode,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    dependsOn: task.dependsOn,
    model: task.activeModel || task.model,
    effort: task.effort,
    provider: task.provider,
    output: task.output,
    summary: task.summary,
    error: task.error,
    activity: task.activity,
    usage: task.usage,
    workingDir: task.workingDir,
    repoRoot: task.repoRoot,
    branch: task.branch,
    baseCommit: task.baseCommit,
    commit: task.commit,
    sessionId: task.sessionId,
    autoCommit: task.autoCommit,
    mergedAt: task.mergedAt,
  };
}

function normalizeDependencies(value, tasks) {
  const input = Array.isArray(value) ? value : String(value || "").split(",");
  const ids = [];
  for (const raw of input) {
    const candidate = String(raw || "").trim();
    if (!candidate) continue;
    if (tasks.has(candidate)) ids.push(candidate);
    else {
      const match = [...tasks.values()].find((task) => task.title.toLowerCase() === candidate.toLowerCase());
      if (match) ids.push(match.id);
    }
  }
  return [...new Set(ids)];
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function appendBounded(current, chunk, limit) {
  const next = String(current || "") + String(chunk || "");
  return next.length > limit ? next.slice(-limit) : next;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runGit(cwd, args, options = {}) {
  const allowed = new Set(options.allowExitCodes || [0]);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const limit = 8 * 1024 * 1024;
    const append = (current, chunk) => {
      const next = current + chunk;
      return next.length > limit ? next.slice(-limit) : next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    const timer = setTimeout(() => child.kill(), options.timeout || 60000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (allowed.has(code)) resolve(stdout);
      else reject(new Error((stderr || stdout || `git ${args[0]} exited with ${code}`).trim().slice(0, 2000)));
    });
  });
}

module.exports = { MultiSessionTaskManager, runGit, publicTask };
