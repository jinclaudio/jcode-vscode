const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "jcode.jcode-vscode";

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
  const content = await fs.readFile(argsLog, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => line.split("\0"));
}

async function run() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "jcode-vscode-test-"));
  const argsLog = path.join(scratch, "args.log");
  const fakeJcode = path.join(scratch, "fake-jcode.py");
  const sourceFile = path.join(scratch, "sample.js");

  await fs.writeFile(
    fakeJcode,
    [
      "#!/usr/bin/env python3",
      "import json, sys, time",
      "args = sys.argv[1:]",
      `open(${JSON.stringify(argsLog)}, 'a').write('\\0'.join(args) + '\\n')`,
      "if 'run' in args:",
      "    prompt = args[-1]",
      "    if 'WAIT_FOR_CANCEL' in prompt:",
      "        time.sleep(30)",
      "    print(json.dumps({'session_id': 'fake-session-1', 'provider': 'test-provider', 'model': 'test-model', 'text': 'FAKE_CHAT_RESPONSE: ' + prompt[:80]}))",
      "    sys.exit(0)",
      "for _line in sys.stdin:",
      "    pass",
    ].join("\n"),
    { mode: 0o755 },
  );
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
    "jcode._test.newChat",
    "jcode._test.cancelChat",
    "jcode._test.captureSelection",
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

  let invocations = await readInvocations(argsLog);
  const firstArgs = invocations[0];
  assert.ok(firstArgs.includes("-C"));
  assert.ok(firstArgs.includes(scratch));
  assert.ok(firstArgs.includes("--provider"));
  assert.ok(firstArgs.includes("test-provider"));
  assert.ok(firstArgs.includes("run"));
  assert.ok(firstArgs.includes("--json"));
  assert.ok(firstArgs.includes("--no-update"));
  assert.equal(firstArgs.includes("--resume"), false);

  const firstPrompt = firstArgs.at(-1);
  assert.match(firstPrompt, /Explain the selected identifiers/);
  assert.match(firstPrompt, /sample\.js/);
  const contextMatch = firstPrompt.match(/Read the exact selection and range metadata from ("(?:[^"\\]|\\.)+")/);
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
  invocations = await readInvocations(argsLog);
  const secondArgs = invocations[1];
  assert.ok(secondArgs.includes("--resume"));
  assert.equal(secondArgs[secondArgs.indexOf("--resume") + 1], "fake-session-1");
  assert.equal(secondArgs.at(-1), "Continue without attaching a selection.");

  const invocationCount = invocations.length;
  await vscode.commands.executeCommand("jcode.explainSelection");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await readInvocations(argsLog)).length, invocationCount);

  await updateSetting("maxSelectionCharacters", 1000);
  const largeDocument = await vscode.workspace.openTextDocument({
    language: "text",
    content: "x".repeat(1200),
  });
  const largeEditor = await vscode.window.showTextDocument(largeDocument);
  largeEditor.selection = new vscode.Selection(0, 0, 0, 1200);
  await vscode.commands.executeCommand("jcode.fixSelection");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await readInvocations(argsLog)).length, invocationCount);

  await vscode.commands.executeCommand("jcode._test.newChat");
  await vscode.commands.executeCommand(
    "jcode._test.sendChat",
    "A fresh conversation.",
    false,
  );
  invocations = await readInvocations(argsLog);
  const freshArgs = invocations[2];
  assert.equal(freshArgs.includes("--resume"), false);

  await vscode.commands.executeCommand("jcode.openTerminal");
  const firstTerminal = await waitFor(
    () => vscode.window.terminals.find((terminal) => terminal.name === "Jcode"),
    "Jcode terminal to be visible",
  );
  invocations = await waitFor(async () => {
    const current = await readInvocations(argsLog);
    return current.length >= 4 ? current : undefined;
  }, "terminal process to start");
  const terminalArgs = invocations[3];
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
    const current = await readInvocations(argsLog);
    return current.some((args) => args.at(-1) === "WAIT_FOR_CANCEL");
  }, "cancellable chat process to start");
  await vscode.commands.executeCommand("jcode._test.cancelChat");
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
  await vscode.commands.executeCommand("jcode._test.newChat");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await fs.rm(scratch, { recursive: true, force: true });

  console.log("JCODE_VSCODE_ACCEPTANCE: PASS");
}

module.exports = { run };
