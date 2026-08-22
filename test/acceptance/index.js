const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const vscode = require("vscode");

const EXTENSION_ID = "claudioj.jcode-vscode";
const execFileAsync = promisify(execFile);

// The fake ACP adapter lives in test/acceptance/fake-acp-bridge.py. It speaks
// the Agent Client Protocol over stdio and logs *normalized* request frames
// (old SDK-style field names) so the assertions below keep working.

async function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${message}`);
}

async function updateSetting(name, value) {
  await vscode.workspace
    .getConfiguration("jcode")
    .update(name, value, vscode.ConfigurationTarget.Global);
}

async function git(cwd, ...args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function readInvocations(argsLog) {
  try {
    const content = await fs.readFile(argsLog, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line) => line.split("\0"));
  } catch {
    return [];
  }
}

async function readBridgeFrames(bridgeLog) {
  try {
    const content = await fs.readFile(bridgeLog, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function run() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "jcode-vscode-test-"));
  const resultMarker = process.env.JCODE_VSCODE_ACCEPTANCE_MARKER || path.join(os.tmpdir(), "jcode-vscode-acceptance-result.txt");
  try {
    await fs.unlink(resultMarker);
  } catch {
    // No previous result; first run.
  }
  const argsLog = path.join(scratch, "args.log");
  const bridgeLog = path.join(scratch, "bridge.log");
  const fakeJcodeHome = path.join(scratch, "fake-jcode-home");
  const fakeJcode = path.join(__dirname, "fake-acp-bridge.py");
  const sourceFile = path.join(scratch, "sample.js");

  // The extension reads JCODE_HOME for the session directory; the fake writes
  // its sessions there so the disk-based session list/history work.
  process.env.JCODE_HOME = fakeJcodeHome;
  process.env.FAKE_ARGS_LOG = argsLog;
  process.env.FAKE_BRIDGE_LOG = bridgeLog;

  await fs.mkdir(fakeJcodeHome, { recursive: true });
  try { await fs.chmod(fakeJcode, 0o755); } catch {}
  await fs.writeFile(sourceFile, "const alpha = 1;\nconst beta = alpha + 2;\n");

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the Extension Host`);
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "jcode.open",
    "jcode.openTerminal",
    "jcode.askSelection",
    "jcode.explainSelection",
    "jcode.fixSelection",
    "jcode._test.sendChat",
    "jcode._test.addPastedImage",
    "jcode._test.newChat",
    "jcode._test.listSessions",
    "jcode._test.attachSession",
    "jcode._test.cancelChat",
    "jcode._test.setModel",
    "jcode._test.setEffort",
    "jcode._test.captureSelection",
    "jcode._test.getChatState",
    "jcode._test.closeClient",
    "jcode._test.useMockView",
    "jcode._test.getPostedMessages",
    "jcode._test.getModelPickerItems",
    "jcode._test.createTask",
    "jcode._test.createTasks",
    "jcode._test.getTasks",
    "jcode._test.cancelTask",
    "jcode._test.diffTask",
    "jcode._test.commitTask",
    "jcode._test.mergeTask",
    "jcode._test.removeTask",
  ]) {
    assert.ok(commands.includes(command), `${command} must be registered`);
  }

  const contribution = extension.packageJSON.contributes;
  assert.equal(contribution.viewsContainers.activitybar[0].id, "jcode");
  assert.equal(contribution.views.jcode[0].id, "jcode.chatView");
  assert.equal(contribution.views.jcode[0].type, "webview");

  await updateSetting("executablePath", fakeJcode);
  await updateSetting("launchArguments", ["--provider", "test-provider"]);
  await updateSetting("maxSelectionCharacters", 200000);
  await vscode.commands.executeCommand("jcode._test.newChat");

  await vscode.commands.executeCommand("jcode._test.useMockView");
  const initialUiResult = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "First sidebar message.",
    false,
  );
  assert.match(initialUiResult.text, /FAKE_CHAT_RESPONSE/);
  const initialUiMessages = await vscode.commands.executeCommand("jcode._test.getPostedMessages");
  const initialUser = initialUiMessages.find((message) => message.type === "user" && message.text === "First sidebar message.");
  assert.ok(initialUser?.turnId, "the first sidebar turn must receive a turn id");
  assert.deepEqual(
    initialUiMessages
      .filter((message) => message.turnId === initialUser.turnId)
      .map((message) => message.type + (message.type === "running" ? `:${message.running}` : "")),
    ["running:true", "user", "sendAccepted", "delta", "assistant", "running:false"],
    "the first sidebar message must reach the webview in usable order",
  );

  await vscode.commands.executeCommand("jcode._test.sendChat", "SHOW_METRICS", false);
  const metricMessages = await vscode.commands.executeCommand("jcode._test.getPostedMessages");
  const runtimeState = metricMessages.filter((message) => message.type === "runtimeState").at(-1)?.state;
  assert.ok(runtimeState, "token and todo events must publish a runtime dashboard state");
  assert.equal(runtimeState.todos.length, 2);
  assert.equal(runtimeState.aggregateConfidence, "validated");
  assert.equal(runtimeState.inputTokens, 250);
  assert.equal(runtimeState.cacheReadTokens, 750);
  assert.equal(runtimeState.effectiveInputTokens, 1000);
  assert.equal(runtimeState.contextTokens, 1000);
  assert.equal(runtimeState.contextLimit, 200000);

  const document = await vscode.workspace.openTextDocument(sourceFile);
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit((builder) => builder.insert(new vscode.Position(2, 0), "// unsaved\n"));
  editor.selections = [
    new vscode.Selection(0, 6, 0, 11),
    new vscode.Selection(1, 6, 1, 10),
  ];

  await vscode.commands.executeCommand("jcode.askSelection");
  const firstResult = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "Explain the selected identifiers.",
    true,
  );
  assert.match(firstResult.text, /FAKE_CHAT_RESPONSE/);
  assert.equal(firstResult.session_id, "fake-session-1");

  const webviewSource = fsSync.readFileSync(path.join(__dirname, "../../extension.js"), "utf8");
  assert.match(webviewSource, /<button id="model"/, "the model catalog must use a visible VS Code picker button");
  assert.match(webviewSource, /id="runtime-indicators"/, "runtime status must use compact composer icons");
  assert.match(webviewSource, /id="runtime-popover"/, "runtime details must be hidden in an on-demand popover");
  assert.match(webviewSource, /data-runtime-panel="todo"/, "each runtime icon must select its own popover panel");
  assert.doesNotMatch(webviewSource, /RUNTIME_DEMO|webviewRuntimeState/, "runtime metrics must come from live Jcode events, not demo data");
  assert.match(webviewSource, /QuickPickItemKind\.Separator/, "the model picker must group models by provider");
  const pickerItems = await vscode.commands.executeCommand(
    "jcode._test.getModelPickerItems",
    ["gpt-5.5", "claude-opus-4-6", "custom-model", "offline-model"],
    [
      { model: "gpt-5.5", provider: "OpenAI", api_method: "openai-oauth", available: true, detail: "ChatGPT account" },
      { model: "gpt-5.5", provider: "OpenAI", api_method: "openai-api-key", available: true, detail: "API key" },
      { model: "claude-opus-4-6", provider: "Anthropic", api_method: "claude-api", available: true, detail: "API key" },
      { model: "custom-model", provider: "NVIDIA NIM", api_method: "openai-compatible:nvidia-nim", available: true, detail: "Connected profile" },
      { model: "offline-model", provider: "Offline provider", api_method: "current", available: false, detail: "Missing credentials" },
    ],
    "gpt-5.5",
    "OpenAI",
    ["OpenAI", "Anthropic", "NVIDIA NIM", "Offline provider"],
  );
  const separators = pickerItems.filter((item) => item.kind === vscode.QuickPickItemKind.Separator).map((item) => item.label);
  assert.deepEqual(separators, ["Automatic", "OpenAI", "Anthropic", "NVIDIA NIM", "Offline provider"]);
  const openAiRoutes = pickerItems.filter((item) => item.displayModel === "gpt-5.5");
  assert.deepEqual(openAiRoutes.map((item) => item.model), ["openai-api:gpt-5.5", "openai-oauth:gpt-5.5"]);
  assert.ok(openAiRoutes.every((item) => item.description === "Current"));
  assert.match(pickerItems.find((item) => item.displayModel === "custom-model").detail, /openai-compatible:nvidia-nim/);
  assert.equal(pickerItems.find((item) => item.displayModel === "custom-model").model, "nvidia-nim:custom-model");
  const unavailableRoute = pickerItems.find((item) => item.displayModel === "offline-model");
  assert.equal(unavailableRoute.model, undefined);
  assert.equal(unavailableRoute.description, "Unavailable");

  let frames = await readBridgeFrames(bridgeLog);
  const createFrame = frames.find((frame) => frame.req === "create_session");
  assert.ok(createFrame, "a session must be created through the harness API");
  const firstSend = frames.find(
    (frame) => frame.req === "send_message" && (frame.content || "").includes("Explain the selected identifiers"),
  );
  assert.ok(firstSend, "the chat message must reach the harness API");
  assert.equal(firstSend.session_id, "fake-session-1");
  assert.match(firstSend.content, /sample\.js/);
  const contextMatch = firstSend.content.match(/Read the exact selection and range metadata from ("(?:[^"\\]|\\.)+")/);
  assert.ok(contextMatch, "prompt must include a JSON-quoted context path");
  const contextPath = JSON.parse(contextMatch[1]);
  const contextText = await fs.readFile(contextPath, "utf8");
  assert.match(contextText, /- Dirty: true/);
  assert.match(contextText, /Selection 1 \(L1:C7-L1:C12\)[\s\S]*alpha/);
  assert.match(contextText, /Selection 2 \(L2:C7-L2:C11\)[\s\S]*beta/);

  let lastSnapshot;
  for (let index = 0; index < 25; index += 1) {
    lastSnapshot = await vscode.commands.executeCommand("jcode._test.captureSelection");
  }
  const snapshotDirectory = vscode.Uri.file(path.dirname(lastSnapshot.contextFile.fsPath));
  const snapshots = (await vscode.workspace.fs.readDirectory(snapshotDirectory))
    .filter(([name, type]) =>
      type === vscode.FileType.File && name.startsWith("selection-") && name.endsWith(".md"),
    );
  assert.equal(snapshots.length, 20, "temporary selection snapshots must be bounded");

  editor.selections = [new vscode.Selection(0, 0, 0, 0)];
  const secondResult = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "Continue without attaching a selection.",
    false,
  );
  assert.match(secondResult.text, /FAKE_CHAT_RESPONSE/);
  assert.equal(secondResult.session_id, "fake-session-1", "multi-turn chat must reuse the session");
  frames = await readBridgeFrames(bridgeLog);
  assert.equal(
    frames.filter((frame) => frame.req === "create_session").length,
    1,
    "multi-turn chat must not create a second session",
  );
  assert.ok(
    frames.some(
      (frame) =>
        frame.req === "send_message" &&
        frame.content.startsWith("Continue without attaching a selection.") &&
        frame.session_id === "fake-session-1",
    ),
  );

  await vscode.commands.executeCommand("jcode._test.setModel", "gpt-5.5");
  frames = await readBridgeFrames(bridgeLog);
  const setModelFrame = frames.find((frame) => frame.req === "set_model");
  assert.ok(setModelFrame, "changing the model must call set_model");
  assert.equal(setModelFrame.model, "gpt-5.5");
  assert.equal(setModelFrame.session_id, "fake-session-1");

  await vscode.commands.executeCommand(
    "jcode._test.setModel",
    "openai-oauth:gpt-5.5",
    "gpt-5.5",
    "OpenAI",
  );
  frames = await readBridgeFrames(bridgeLog);
  assert.ok(
    frames.some((frame) => frame.req === "set_model" && frame.model === "openai-oauth:gpt-5.5"),
    "choosing a provider route must send Jcode's exact routed model spec",
  );
  assert.equal(
    (await vscode.commands.executeCommand("jcode._test.getChatState")).model,
    "gpt-5.5",
    "the composer must show the clean model name rather than its routing prefix",
  );

  await vscode.commands.executeCommand("jcode._test.setEffort", "high");
  frames = await readBridgeFrames(bridgeLog);
  const setEffortFrame = frames.find((frame) => frame.req === "set_reasoning_effort");
  assert.ok(setEffortFrame, "changing the effort must call set_reasoning_effort");
  assert.equal(setEffortFrame.effort, "high");
  assert.equal(setEffortFrame.session_id, "fake-session-1");

  const modelSetsBeforeSend = frames.filter((frame) => frame.req === "set_model").length;
  const effortSetsBeforeSend = frames.filter((frame) => frame.req === "set_reasoning_effort").length;
  const sameOptionsResult = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "Send without reapplying unchanged options.",
    false,
    { model: "gpt-5.5", effort: "high" },
  );
  assert.match(sameOptionsResult.text, /FAKE_CHAT_RESPONSE/);
  frames = await readBridgeFrames(bridgeLog);
  assert.equal(
    frames.filter((frame) => frame.req === "set_model").length,
    modelSetsBeforeSend,
    "sending must not reapply an unchanged model",
  );
  assert.equal(
    frames.filter((frame) => frame.req === "set_reasoning_effort").length,
    effortSetsBeforeSend,
    "sending must not reapply unchanged reasoning effort",
  );

  // Native slash commands are handled by the extension through the matching
  // harness API operations, not sent to the model as ordinary prompts.
  const sendCountBeforeSlash = frames.filter((frame) => frame.req === "send_message").length;
  await vscode.commands.executeCommand("jcode._test.sendChat", "/model test-model-b", false);
  await vscode.commands.executeCommand("jcode._test.sendChat", "/effort low", false);
  await vscode.commands.executeCommand("jcode._test.sendChat", "/clear", false);
  frames = await readBridgeFrames(bridgeLog);
  assert.ok(frames.some((frame) => frame.req === "set_model" && frame.model === "test-model-b"));
  assert.ok(frames.some((frame) => frame.req === "set_reasoning_effort" && frame.effort === "low"));
  assert.ok(frames.some((frame) => frame.req === "send_message" && frame.content === "/clear"));
  assert.equal(
    frames.filter((frame) => frame.req === "send_message").length,
    sendCountBeforeSlash + 1,
    "only /clear is sent as a prompt; /model and /effort route to native operations",
  );

  const imageId = await vscode.commands.executeCommand(
    "jcode._test.addPastedImage",
    "image/png",
    Buffer.from("hello").toString("base64"),
    "diagram.png",
  );
  assert.ok(imageId, "pasted image must be staged as an attachment");
  const imageResult = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "Describe the attached image.",
    false,
    { attachmentIds: [imageId] },
  );
  assert.match(imageResult.text, /FAKE_CHAT_RESPONSE/);
  frames = await readBridgeFrames(bridgeLog);
  const imageSend = frames.find(
    (frame) => frame.req === "send_message" && frame.content.startsWith("Describe the attached image."),
  );
  assert.deepEqual(imageSend.images, [["image/png", Buffer.from("hello").toString("base64")]]);

  const literalSlashResult = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "//path/to/file fails; explain why.",
    false,
  );
  assert.match(literalSlashResult.text, /FAKE_CHAT_RESPONSE/);
  frames = await readBridgeFrames(bridgeLog);
  assert.ok(
    frames.some(
      (frame) => frame.req === "send_message" && frame.content.startsWith("/path/to/file fails; explain why."),
    ),
    "a // prefix must escape a literal leading slash",
  );

  // A rejected model must not break the session; the error surfaces as a notice.
  await vscode.commands.executeCommand("jcode._test.setModel", "bad-model");
  frames = await readBridgeFrames(bridgeLog);
  assert.ok(frames.some((frame) => frame.req === "set_model" && frame.model === "bad-model"));
  assert.equal(
    (await vscode.commands.executeCommand("jcode._test.getChatState")).model,
    "test-model-b",
    "a rejected model must not replace the last successfully applied model",
  );

  const attachCountBeforeReconnect = frames.filter((frame) => frame.req === "attach_session").length;
  await vscode.commands.executeCommand("jcode._test.closeClient");
  const reconnectResult = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "Reconnect and continue the same session.",
    false,
  );
  assert.match(reconnectResult.text, /FAKE_CHAT_RESPONSE/);
  frames = await readBridgeFrames(bridgeLog);
  assert.ok(
    frames.filter((frame) => frame.req === "attach_session").length > attachCountBeforeReconnect,
    "a replacement SDK connection must reattach the existing session before sending",
  );

  const framesBeforeNoop = (await readBridgeFrames(bridgeLog)).length;
  await vscode.commands.executeCommand("jcode.explainSelection");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await readBridgeFrames(bridgeLog)).length, framesBeforeNoop);

  await updateSetting("maxSelectionCharacters", 1000);
  const largeDocument = await vscode.workspace.openTextDocument({
    language: "text",
    content: "x".repeat(1200),
  });
  const largeEditor = await vscode.window.showTextDocument(largeDocument);
  largeEditor.selection = new vscode.Selection(0, 0, 0, 1200);
  await vscode.commands.executeCommand("jcode.fixSelection");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await readBridgeFrames(bridgeLog)).length, framesBeforeNoop);
  await updateSetting("maxSelectionCharacters", 200000);

  await vscode.commands.executeCommand("jcode._test.useMockView");
  await vscode.commands.executeCommand("jcode._test.newChat");
  assert.equal(
    (await vscode.commands.executeCommand("jcode._test.getChatState")).sessionId,
    "fake-session-2",
    "New Chat must create and activate a distinct session before the next message",
  );
  await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "A fresh conversation.",
    false,
  );
  frames = await readBridgeFrames(bridgeLog);
  const freshSession = frames.filter((frame) => frame.req === "create_session");
  assert.equal(freshSession.length, 2, "New Chat must create a second session");
  assert.equal(freshSession[1].id !== undefined, true);

  assert.equal(await vscode.commands.executeCommand("jcode._test.attachSession", "fake-session-1"), true);
  assert.equal((await vscode.commands.executeCommand("jcode._test.getChatState")).sessionId, "fake-session-1");
  const firstSessionRestore = await waitFor(async () => {
    const posted = await vscode.commands.executeCommand("jcode._test.getPostedMessages");
    return posted
      .filter((message) => message.type === "restore" && message.sessionId === "fake-session-1")
      .at(-1);
  }, "selected first session transcript to reach the Webview");
  assert.ok(firstSessionRestore, "switching must publish the selected session transcript");
  assert.ok(firstSessionRestore.history.some((message) => message.content.includes("First sidebar message.")));
  assert.equal(firstSessionRestore.history.some((message) => message.content.includes("A fresh conversation.")), false);
  const resumedFirst = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "Continue the first conversation.",
    false,
  );
  assert.equal(resumedFirst.session_id, "fake-session-1");

  assert.equal(await vscode.commands.executeCommand("jcode._test.attachSession", "fake-session-2"), true);
  const secondSessionRestore = await waitFor(async () => {
    const posted = await vscode.commands.executeCommand("jcode._test.getPostedMessages");
    return posted
      .filter((message) => message.type === "restore" && message.sessionId === "fake-session-2")
      .at(-1);
  }, "selected second session transcript to reach the Webview");
  assert.ok(secondSessionRestore.history.some((message) => message.content.includes("A fresh conversation.")));
  assert.equal(secondSessionRestore.history.some((message) => message.content.includes("Continue the first conversation.")), false);
  await vscode.commands.executeCommand("jcode._test.listSessions");
  const sessionListMessage = await waitFor(async () => {
    const posted = await vscode.commands.executeCommand("jcode._test.getPostedMessages");
    return posted.filter((message) => message.type === "sessions" && message.open).at(-1);
  }, "session switcher state to reach the Webview");
  assert.equal(sessionListMessage.currentSessionId, "fake-session-2");
  assert.deepEqual(sessionListMessage.sessions.map((session) => session.session_id), ["fake-session-1", "fake-session-2"]);

  const framesBeforeCompetingSwitches = (await readBridgeFrames(bridgeLog)).length;
  const competingSwitches = await Promise.all([
    vscode.commands.executeCommand("jcode._test.attachSession", "fake-session-1"),
    vscode.commands.executeCommand("jcode._test.attachSession", "fake-session-2"),
  ]);
  assert.deepEqual(competingSwitches, [true, true]);
  assert.equal(
    (await vscode.commands.executeCommand("jcode._test.getChatState")).sessionId,
    "fake-session-2",
    "competing switches must finish in request order without mixing session state",
  );
  const restoreAfterCompetingSwitches = (await vscode.commands.executeCommand("jcode._test.getPostedMessages"))
    .filter((message) => message.type === "restore")
    .at(-1);
  assert.equal(restoreAfterCompetingSwitches.sessionId, "fake-session-2");
  assert.ok(restoreAfterCompetingSwitches.history.some((message) => message.content.includes("A fresh conversation.")));
  const competingFrames = (await readBridgeFrames(bridgeLog)).slice(framesBeforeCompetingSwitches);
  const firstAttachIndex = competingFrames.findIndex(
    (frame) => frame.req === "attach_session" && frame.session_id === "fake-session-1",
  );
  const secondAttachIndex = competingFrames.findIndex(
    (frame) => frame.req === "attach_session" && frame.session_id === "fake-session-2",
  );
  assert.ok(firstAttachIndex >= 0 && secondAttachIndex > firstAttachIndex,
    "competing switches must attach in request order");

  await vscode.commands.executeCommand("jcode._test.setModel", "");
  await vscode.commands.executeCommand("jcode._test.setEffort", "");

  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("jcode.openTerminal");
  const firstTerminal = await waitFor(
    () => vscode.window.terminals.find((terminal) => terminal.name === "Jcode"),
    "Jcode terminal to be visible",
  );
  const invocations = await waitFor(async () => {
    const current = await readInvocations(argsLog);
    return current.length >= 1 ? current : undefined;
  }, "terminal process to start");
  const terminalArgs = invocations[0];
  assert.deepEqual(terminalArgs.slice(-2), ["--provider", "test-provider"]);
  assert.ok(terminalArgs.includes("-C"));
  assert.ok(terminalArgs.includes(scratch));
  firstTerminal.dispose();
  await waitFor(
    () => !vscode.window.terminals.includes(firstTerminal),
    "disposed terminal to close",
  );

  await updateSetting("executablePath", "jcode");
  await updateSetting("launchArguments", ["--no-update"]);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("jcode.openTerminal");
  const realTerminal = await waitFor(
    () => vscode.window.terminals.find((terminal) => terminal.name === "Jcode"),
    "real Jcode terminal to be created",
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(realTerminal.exitStatus, undefined, "real Jcode process must remain running");
  const realPid = await realTerminal.processId;
  assert.ok(Number.isInteger(realPid) && realPid > 0, "real Jcode terminal must expose a process ID");
  if (process.platform === "linux") {
    const commandLine = (await fs.readFile(`/proc/${realPid}/cmdline`, "utf8"))
      .split("\0")
      .filter(Boolean);
    assert.match(commandLine[0], /jcode/);
    assert.ok(commandLine.includes("--no-update"));
    assert.equal(await fs.readlink(`/proc/${realPid}/cwd`), scratch);
  }
  realTerminal.dispose();

  await updateSetting("executablePath", fakeJcode);
  await updateSetting("launchArguments", []);
  const sessionBeforeRunningNewChat = (await vscode.commands.executeCommand("jcode._test.getChatState")).sessionId;
  const runningBeforeNewChat = vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "WAIT_FOR_CANCEL BEFORE_NEW_CHAT",
    false,
  );
  await waitFor(async () => {
    const current = await readBridgeFrames(bridgeLog);
    return current.some((frame) => frame.req === "send_message" && frame.content.startsWith("WAIT_FOR_CANCEL BEFORE_NEW_CHAT"));
  }, "message running before New Chat to reach the bridge");
  await vscode.commands.executeCommand("jcode._test.newChat");
  assert.equal(await runningBeforeNewChat, undefined);
  const sessionAfterRunningNewChat = (await vscode.commands.executeCommand("jcode._test.getChatState")).sessionId;
  assert.notEqual(sessionAfterRunningNewChat, sessionBeforeRunningNewChat);
  assert.ok(
    (await readBridgeFrames(bridgeLog)).some(
      (frame) => frame.req === "cancel" && frame.session_id === sessionBeforeRunningNewChat,
    ),
    "New Chat must cancel and settle the old turn before replacing its session",
  );
  const afterRunningNewChat = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "Fresh session after running New Chat.",
    false,
  );
  assert.equal(afterRunningNewChat.session_id, sessionAfterRunningNewChat);

  const sessionBeforeSyntheticNewChat = sessionAfterRunningNewChat;
  const syntheticBeforeNewChat = vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "/btw WAIT_FOR_CANCEL SYNTHETIC_NEW_CHAT",
    false,
  );
  await waitFor(async () => {
    const current = await readBridgeFrames(bridgeLog);
    return current.some(
      (frame) => frame.req === "send_message" && frame.content.includes("WAIT_FOR_CANCEL SYNTHETIC_NEW_CHAT"),
    );
  }, "synthetic prompt turn running before New Chat to reach the bridge");
  await vscode.commands.executeCommand("jcode._test.newChat");
  assert.equal(await syntheticBeforeNewChat, undefined);
  const sessionAfterSyntheticNewChat = (await vscode.commands.executeCommand("jcode._test.getChatState")).sessionId;
  assert.notEqual(sessionAfterSyntheticNewChat, sessionBeforeSyntheticNewChat);
  assert.ok(
    (await readBridgeFrames(bridgeLog)).some(
      (frame) => frame.req === "cancel" && frame.session_id === sessionBeforeSyntheticNewChat,
    ),
    "New Chat must settle a synthetic prompt turn before replacing its session",
  );

  const cancellation = vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "WAIT_FOR_CANCEL",
    false,
  );
  await waitFor(async () => {
    const current = await readBridgeFrames(bridgeLog);
    return current.some((frame) => frame.req === "send_message" && frame.content.startsWith("WAIT_FOR_CANCEL VS Code context:"));
  }, "cancellable message to be sent");
  const sendCountDuringTurn = (await readBridgeFrames(bridgeLog)).filter((frame) => frame.req === "send_message").length;
  const steering = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "STEER_CURRENT_RESPONSE",
    false,
  );
  assert.equal(steering.steering, true);
  assert.equal(
    (await readBridgeFrames(bridgeLog)).filter((frame) => frame.req === "send_message").length,
    sendCountDuringTurn,
    "steering must not start a second model turn",
  );
  // ACP has no mid-turn soft interrupt, so steering must not cross the bridge;
  // the extension still acknowledges the steering locally without a second turn.
  await vscode.commands.executeCommand("jcode._test.sendChat", "/cancel", false);
  assert.equal(
    (await readBridgeFrames(bridgeLog)).some(
      (frame) => frame.req === "send_message" && frame.content === "/cancel",
    ),
    false,
    "/cancel must route to the SDK cancel operation rather than the model",
  );
  assert.equal(await cancellation, undefined);
  const afterCancellation = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "Chat remains usable after cancellation.",
    false,
  );
  assert.match(afterCancellation.text, /FAKE_CHAT_RESPONSE/);

  await updateSetting("multiSession.enabled", true);
  await updateSetting("multiSession.maxConcurrent", 2);
  await updateSetting("multiSession.autoCommit", false);

  const staleTasks = await vscode.commands.executeCommand("jcode._test.getTasks");
  for (const task of staleTasks) {
    if (["running", "queued", "preparing", "detached"].includes(task.status)) {
      await vscode.commands.executeCommand("jcode._test.cancelTask", task.id);
    }
    await vscode.commands.executeCommand("jcode._test.removeTask", task.id, true);
  }

  const parallelTasks = await vscode.commands.executeCommand("jcode._test.createTasks", [
    { title: "Parallel alpha", prompt: "WAIT_FOR_CANCEL alpha", mode: "read-only" },
    { title: "Parallel beta", prompt: "WAIT_FOR_CANCEL beta", mode: "read-only" },
    { title: "Parallel gamma", prompt: "WAIT_FOR_CANCEL gamma", mode: "read-only" },
  ]);
  assert.equal(parallelTasks.length, 3);
  const runningParallel = await waitFor(async () => {
    const current = await vscode.commands.executeCommand("jcode._test.getTasks");
    const selected = current.filter((task) => parallelTasks.some((created) => created.id === task.id));
    const running = selected.filter((task) => task.status === "running" && task.sessionId);
    const queued = selected.filter((task) => task.status === "queued");
    return selected.length === 3 && running.length === 2 && queued.length === 1
      ? selected
      : undefined;
  }, "two Jcode task sessions to run concurrently");
  const initialRunning = runningParallel.filter((task) => task.status === "running");
  assert.equal(new Set(initialRunning.map((task) => task.sessionId)).size, 2, "parallel tasks must own distinct sessions");
  const parallelFrames = await readBridgeFrames(bridgeLog);
  assert.equal(
    parallelFrames.filter(
      (frame) => frame.req === "send_message" &&
        (frame.content.includes("WAIT_FOR_CANCEL alpha") || frame.content.includes("WAIT_FOR_CANCEL beta")),
    ).length,
    2,
    "both parallel task prompts must cross the SDK bridge",
  );
  await vscode.commands.executeCommand("jcode._test.cancelTask", parallelTasks[0].id);
  await waitFor(async () => {
    const current = await vscode.commands.executeCommand("jcode._test.getTasks");
    return current.find((task) => task.id === parallelTasks[0].id)?.status === "cancelled";
  }, "the first parallel task to cancel independently");
  const afterFirstTaskCancel = await waitFor(async () => {
    const current = await vscode.commands.executeCommand("jcode._test.getTasks");
    return current.find((task) => task.id === parallelTasks[2].id)?.status === "running" ? current : undefined;
  }, "the queued task to start when a worker slot becomes available");
  assert.equal(afterFirstTaskCancel.find((task) => task.id === parallelTasks[1].id)?.status, "running");
  await vscode.commands.executeCommand("jcode._test.cancelTask", parallelTasks[1].id);
  await vscode.commands.executeCommand("jcode._test.cancelTask", parallelTasks[2].id);
  await waitFor(async () => {
    const current = await vscode.commands.executeCommand("jcode._test.getTasks");
    return parallelTasks.slice(1).every((created) => current.find((task) => task.id === created.id)?.status === "cancelled");
  }, "the remaining parallel tasks to cancel independently");

  const dependencyA = await vscode.commands.executeCommand("jcode._test.createTask", {
    title: "Dependency A",
    prompt: "Return dependency A result.",
    mode: "read-only",
  });
  const dependencyB = await vscode.commands.executeCommand("jcode._test.createTask", {
    title: "Dependency B",
    prompt: "Return dependency B result.",
    mode: "read-only",
  });
  const coordinator = await vscode.commands.executeCommand("jcode._test.createTask", {
    title: "Coordinator",
    prompt: "Synthesize the completed dependency work.",
    kind: "coordinator",
    mode: "worktree",
    dependsOn: [dependencyA.id, dependencyB.id],
  });
  assert.equal(coordinator.mode, "read-only", "coordinator tasks must never receive an editable worktree");
  await waitFor(async () => {
    const current = await vscode.commands.executeCommand("jcode._test.getTasks");
    return current.find((task) => task.id === coordinator.id)?.status === "completed";
  }, "dependency workers and coordinator to complete");
  const coordinatorFrame = (await readBridgeFrames(bridgeLog)).find(
    (frame) => frame.req === "send_message" && frame.content.includes('assigned task "Coordinator"'),
  );
  assert.ok(coordinatorFrame, "coordinator prompt must cross the SDK bridge");
  assert.match(coordinatorFrame.content, /Dependency A \(completed\)/);
  assert.match(coordinatorFrame.content, /Dependency B \(completed\)/);
  assert.match(coordinatorFrame.content, /Do not modify files/);

  await updateSetting("multiSession.enabled", false);
  await assert.rejects(
    vscode.commands.executeCommand("jcode._test.createTask", {
      title: "Disabled task",
      prompt: "This must not run.",
      mode: "read-only",
    }),
    /disabled/i,
  );
  await updateSetting("multiSession.enabled", true);

  const gitRepo = path.join(scratch, "worktree-repo");
  await fs.mkdir(gitRepo, { recursive: true });
  await git(gitRepo, "init", "-b", "main");
  await git(gitRepo, "config", "user.name", "Jcode Acceptance");
  await git(gitRepo, "config", "user.email", "acceptance@jcode.test");
  await fs.writeFile(path.join(gitRepo, "README.md"), "# Worktree fixture\n");
  await git(gitRepo, "add", "README.md");
  await git(gitRepo, "commit", "-m", "fixture: initialize");
  const repoDocument = await vscode.workspace.openTextDocument(path.join(gitRepo, "README.md"));
  await vscode.window.showTextDocument(repoDocument);

  const worktreeTask = await vscode.commands.executeCommand("jcode._test.createTask", {
    title: "Isolated implementation",
    prompt: "Complete the isolated fixture task.",
    mode: "worktree",
    autoCommit: false,
  });
  const completedWorktree = await waitFor(async () => {
    const current = await vscode.commands.executeCommand("jcode._test.getTasks");
    const task = current.find((item) => item.id === worktreeTask.id);
    return task?.status === "completed" && task.workingDir && task.branch ? task : undefined;
  }, "worktree task to complete in its isolated directory", 20000);
  assert.notEqual(completedWorktree.workingDir, gitRepo);
  assert.equal(await git(completedWorktree.workingDir, "rev-parse", "--show-toplevel"), completedWorktree.workingDir);
  await fs.writeFile(path.join(completedWorktree.workingDir, "feature.txt"), "isolated task output\n");
  const untrackedDiff = await vscode.commands.executeCommand("jcode._test.diffTask", worktreeTask.id);
  assert.match(untrackedDiff, /feature\.txt/);
  assert.match(untrackedDiff, /isolated task output/);
  const taskCommit = await vscode.commands.executeCommand("jcode._test.commitTask", worktreeTask.id);
  assert.match(taskCommit, /^[0-9a-f]{40}$/);
  assert.equal(await fs.readFile(path.join(gitRepo, "README.md"), "utf8"), "# Worktree fixture\n");
  const mergedCommits = await vscode.commands.executeCommand("jcode._test.mergeTask", worktreeTask.id);
  assert.ok(mergedCommits.includes(taskCommit));
  assert.equal(await fs.readFile(path.join(gitRepo, "feature.txt"), "utf8"), "isolated task output\n");
  assert.equal(await git(gitRepo, "status", "--porcelain"), "");
  await vscode.commands.executeCommand("jcode._test.removeTask", worktreeTask.id, false);
  assert.equal(fsSync.existsSync(completedWorktree.workingDir), false, "removed tasks must clean up their worktrees");
  await vscode.window.showTextDocument(repoDocument);

  const mergePair = await vscode.commands.executeCommand("jcode._test.createTasks", [
    { title: "Concurrent merge A", prompt: "Complete merge fixture A.", mode: "worktree", autoCommit: false },
    { title: "Concurrent merge B", prompt: "Complete merge fixture B.", mode: "worktree", autoCommit: false },
  ]);
  const completedMergePair = await waitFor(async () => {
    const current = await vscode.commands.executeCommand("jcode._test.getTasks");
    const selected = current.filter((task) => mergePair.some((created) => created.id === task.id));
    return selected.length === 2 && selected.every((task) => task.status === "completed") ? selected : undefined;
  }, "both concurrent merge fixtures to complete", 20000);
  await fs.writeFile(path.join(completedMergePair[0].workingDir, "merge-a.txt"), "merge A\n");
  await fs.writeFile(path.join(completedMergePair[1].workingDir, "merge-b.txt"), "merge B\n");
  await vscode.commands.executeCommand("jcode._test.commitTask", completedMergePair[0].id);
  await vscode.commands.executeCommand("jcode._test.commitTask", completedMergePair[1].id);
  await Promise.all([
    vscode.commands.executeCommand("jcode._test.mergeTask", completedMergePair[0].id),
    vscode.commands.executeCommand("jcode._test.mergeTask", completedMergePair[1].id),
  ]);
  assert.equal(await fs.readFile(path.join(gitRepo, "merge-a.txt"), "utf8"), "merge A\n");
  assert.equal(await fs.readFile(path.join(gitRepo, "merge-b.txt"), "utf8"), "merge B\n");
  assert.equal(await git(gitRepo, "status", "--porcelain"), "");
  for (const task of completedMergePair) {
    await vscode.commands.executeCommand("jcode._test.removeTask", task.id, false);
  }

  const conflictTask = await vscode.commands.executeCommand("jcode._test.createTask", {
    title: "Conflicting implementation",
    prompt: "Complete the conflict fixture task.",
    mode: "worktree",
    autoCommit: false,
  });
  const completedConflict = await waitFor(async () => {
    const current = await vscode.commands.executeCommand("jcode._test.getTasks");
    const task = current.find((item) => item.id === conflictTask.id);
    return task?.status === "completed" && task.workingDir ? task : undefined;
  }, "conflict worktree task to complete", 20000);
  await fs.writeFile(path.join(completedConflict.workingDir, "README.md"), "# Task branch version\n");
  await vscode.commands.executeCommand("jcode._test.commitTask", conflictTask.id);
  await fs.writeFile(path.join(gitRepo, "README.md"), "# Main branch version\n");
  await git(gitRepo, "add", "README.md");
  await git(gitRepo, "commit", "-m", "fixture: create merge conflict");
  await assert.rejects(
    vscode.commands.executeCommand("jcode._test.mergeTask", conflictTask.id),
    /conflict/i,
  );
  assert.equal(await fs.readFile(path.join(gitRepo, "README.md"), "utf8"), "# Main branch version\n");
  assert.equal(await git(gitRepo, "status", "--porcelain"), "", "failed task merges must abort cleanly");
  await vscode.commands.executeCommand("jcode._test.removeTask", conflictTask.id, true);
  assert.equal(fsSync.existsSync(completedConflict.workingDir), false);
  await vscode.window.showTextDocument(document);

  const remainingTasks = await vscode.commands.executeCommand("jcode._test.getTasks");
  for (const task of remainingTasks) {
    await vscode.commands.executeCommand("jcode._test.removeTask", task.id, true);
  }

  await updateSetting("executablePath", undefined);
  await updateSetting("launchArguments", undefined);
  await updateSetting("maxSelectionCharacters", undefined);
  await updateSetting("multiSession.enabled", undefined);
  await updateSetting("multiSession.maxConcurrent", undefined);
  await updateSetting("multiSession.autoCommit", undefined);
  delete process.env.JCODE_HOME;
  delete process.env.FAKE_ARGS_LOG;
  delete process.env.FAKE_BRIDGE_LOG;
  await vscode.commands.executeCommand("jcode._test.newChat");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await fs.writeFile(resultMarker, "PASS\n");
  await fs.rm(scratch, { recursive: true, force: true });

  console.log("JCODE_VSCODE_ACCEPTANCE: PASS");
}

module.exports = {
  run: async () => {
    try {
      return await run();
    } catch (error) {
      const marker = process.env.JCODE_VSCODE_ACCEPTANCE_MARKER || path.join(os.tmpdir(), "jcode-vscode-acceptance-result.txt");
      await fs.writeFile(marker, `FAIL\n${error?.stack || error}\n`);
      throw error;
    }
  },
};
