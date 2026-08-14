const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "jcode.jcode-vscode";

const FAKE_BRIDGE_PY = String.raw`#!/usr/bin/env python3
import json, os, socket, sys, threading, time

ARGS_LOG = os.environ.get("FAKE_ARGS_LOG", "")
BRIDGE_LOG = os.environ.get("FAKE_BRIDGE_LOG", "")

def log_args():
    if ARGS_LOG:
        with open(ARGS_LOG, "a") as f:
            f.write("\0".join(sys.argv[1:]) + "\n")

def log_frame(frame):
    if BRIDGE_LOG:
        with open(BRIDGE_LOG, "a") as f:
            f.write(json.dumps(frame) + "\n")

args = sys.argv[1:]
if "api-bridge" not in args:
    log_args()
    for _line in sys.stdin:
        pass
    sys.exit(0)

sock_path = None
for i, a in enumerate(args):
    if a == "--api-socket" and i + 1 < len(args):
        sock_path = args[i + 1]
if not sock_path:
    sock_path = os.environ.get("JCODE_API_SOCKET", "/tmp/fake-jcode-api.sock")
try:
    os.unlink(sock_path)
except FileNotFoundError:
    pass

MODELS = ["test-model-a", "test-model-b", "gpt-5.5", "claude-opus-4-6"]
state = {"sessions": {}, "next_session": 1, "current": "test-model-a"}

def emit(conn, frame):
    conn.sendall((json.dumps(frame) + "\n").encode())

def send_message(conn, frame):
    sid = frame["session_id"]
    content = frame["content"]
    emit(conn, {"v": 1, "ev": "message_accepted", "session_id": sid})
    if "WAIT_FOR_CANCEL" in content:
        state.setdefault("pending", []).append((conn, sid))
        return
    text = "FAKE_CHAT_RESPONSE: " + content[:80]
    emit(conn, {"v": 1, "ev": "text_delta", "session_id": sid, "text": text})
    emit(conn, {"v": 1, "ev": "turn_done", "session_id": sid})

def handle(conn, frame):
    log_frame(frame)
    req = frame.get("req")
    rid = frame.get("id")
    reply = lambda ev, **kw: emit(conn, {"v": 1, "reply_to": rid, "ev": ev, **kw})
    if req == "hello":
        reply("hello_ok", version=1, server="fake-jcode-bridge/0.1.0",
              capabilities=["sessions", "streaming", "runtime_info"])
    elif req == "create_session":
        sid = "fake-session-%d" % state["next_session"]
        state["next_session"] += 1
        state["sessions"][sid] = {"working_dir": frame.get("working_dir")}
        reply("attached", session={"session_id": sid, "working_dir": frame.get("working_dir"), "status": "idle"})
    elif req == "attach_session":
        sid = frame["session_id"]
        if sid not in state["sessions"]:
            reply("error", code="unknown_session", message="no such session")
        else:
            reply("attached", session={"session_id": sid, "working_dir": state["sessions"][sid]["working_dir"], "status": "idle"})
    elif req == "detach_session":
        reply("ok")
    elif req == "list_models":
        reply("models", session_id=frame["session_id"], models=MODELS, current=state["current"])
    elif req == "get_runtime_info":
        reply("runtime_info", session_id=frame["session_id"], provider="test-provider",
              model=state["current"], routes=[])
    elif req == "set_model":
        model = frame["model"]
        if model == "bad-model":
            reply("error", code="invalid_request", message="unknown model")
        else:
            state["current"] = model
            reply("ok")
    elif req == "set_reasoning_effort":
        reply("ok")
    elif req == "send_message":
        send_message(conn, frame)
    elif req == "cancel":
        reply("ok")
        sid = frame.get("session_id")
        pending = state.get("pending", [])
        state["pending"] = [p for p in pending if p != (conn, sid)]
        if (conn, sid) in pending:
            emit(conn, {"v": 1, "ev": "text_delta", "session_id": sid, "text": "FAKE_CHAT_RESPONSE: partial"})
            emit(conn, {"v": 1, "ev": "turn_done", "session_id": sid})
    elif req == "clear":
        reply("ok")
    elif req == "ping":
        reply("pong")
    else:
        reply("error", code="unknown_request", message="unhandled: " + str(req))

def serve(conn):
    buf = b""
    try:
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    frame = json.loads(line.decode())
                except json.JSONDecodeError:
                    continue
                handle(conn, frame)
    except (ConnectionError, OSError):
        return

def watchdog(sock_path):
    while True:
        time.sleep(0.5)
        if not os.path.exists(sock_path):
            os._exit(0)

srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(sock_path)
srv.listen(8)
threading.Thread(target=watchdog, args=(sock_path,), daemon=True).start()
while True:
    conn, _ = srv.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
`;

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
  const apiSocket = path.join(scratch, "api.sock");
  const fakeJcode = path.join(scratch, "fake-jcode.py");
  const sourceFile = path.join(scratch, "sample.js");

  // The extension (running in this same Extension Host) reads these variables
  // to know where to reach the bridge and where the fake should log.
  process.env.JCODE_API_SOCKET = apiSocket;
  process.env.FAKE_ARGS_LOG = argsLog;
  process.env.FAKE_BRIDGE_LOG = bridgeLog;

  await fs.writeFile(fakeJcode, FAKE_BRIDGE_PY, { mode: 0o755 });
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
    "jcode._test.cancelChat",
    "jcode._test.setModel",
    "jcode._test.setEffort",
    "jcode._test.captureSelection",
    "jcode._test.getChatState",
    "jcode._test.closeClient",
    "jcode._test.useMockView",
    "jcode._test.getPostedMessages",
    "jcode._test.getModelPickerItems",
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
  assert.match(webviewSource, /QuickPickItemKind\.Separator/, "the model picker must group models by provider");
  const pickerItems = await vscode.commands.executeCommand(
    "jcode._test.getModelPickerItems",
    ["gpt-5.5", "claude-opus-4-6", "custom-model"],
    [{ model: "custom-model", provider: "custom-provider", available: true }],
    "gpt-5.5",
  );
  const separators = pickerItems.filter((item) => item.kind === vscode.QuickPickItemKind.Separator).map((item) => item.label);
  assert.deepEqual(separators, ["Automatic", "Anthropic", "custom-provider", "OpenAI"]);
  assert.equal(pickerItems.find((item) => item.model === "gpt-5.5").description, "Current");
  assert.equal(pickerItems.find((item) => item.model === "custom-model").detail, "custom-provider");

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
  assert.ok(frames.some((frame) => frame.req === "clear" && frame.session_id === "fake-session-1"));
  assert.equal(
    frames.filter((frame) => frame.req === "send_message").length,
    sendCountBeforeSlash,
    "slash commands must not be sent as model prompts",
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

  await vscode.commands.executeCommand("jcode._test.newChat");
  await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "A fresh conversation.",
    false,
  );
  frames = await readBridgeFrames(bridgeLog);
  const freshSession = frames.filter((frame) => frame.req === "create_session");
  assert.equal(freshSession.length, 2, "New Chat must create a second session");
  assert.equal(freshSession[1].id !== undefined, true);

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
  const cancellation = vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "WAIT_FOR_CANCEL",
    false,
  );
  await waitFor(async () => {
    const current = await readBridgeFrames(bridgeLog);
    return current.some((frame) => frame.req === "send_message" && frame.content.startsWith("WAIT_FOR_CANCEL"));
  }, "cancellable message to be sent");
  const sendCountDuringTurn = (await readBridgeFrames(bridgeLog)).filter((frame) => frame.req === "send_message").length;
  const rejectedConcurrent = await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "This concurrent send must be rejected.",
    false,
  );
  assert.equal(rejectedConcurrent, undefined);
  assert.equal(
    (await readBridgeFrames(bridgeLog)).filter((frame) => frame.req === "send_message").length,
    sendCountDuringTurn,
    "a second send must not reach the daemon while a turn is active",
  );
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

  await updateSetting("executablePath", undefined);
  await updateSetting("launchArguments", undefined);
  await updateSetting("maxSelectionCharacters", undefined);
  delete process.env.JCODE_API_SOCKET;
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
