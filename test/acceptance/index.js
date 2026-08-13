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

async function run() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "jcode-vscode-test-"));
  const stdinLog = path.join(scratch, "stdin.log");
  const argsLog = path.join(scratch, "args.log");
  const fakeJcode = path.join(scratch, "fake-jcode.py");
  const sourceFile = path.join(scratch, "sample.js");

  await fs.writeFile(
    fakeJcode,
    [
      "#!/usr/bin/env python3",
      "import os, sys",
      `open(${JSON.stringify(argsLog)}, 'a').write('\\0'.join(sys.argv[1:]) + '\\n')`,
      `with open(${JSON.stringify(stdinLog)}, 'a', buffering=1) as output:`,
      "    for line in sys.stdin:",
      "        output.write(line)",
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
    "jcode.askSelection",
    "jcode.explainSelection",
    "jcode.fixSelection",
  ]) {
    assert.ok(commands.includes(command), `${command} must be registered`);
  }

  await updateSetting("executablePath", fakeJcode);
  await updateSetting("launchArguments", ["--provider", "test-provider"]);
  await updateSetting("maxSelectionCharacters", 200000);

  const document = await vscode.workspace.openTextDocument(sourceFile);
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit((builder) => builder.insert(new vscode.Position(2, 0), "// unsaved\n"));
  editor.selections = [
    new vscode.Selection(0, 6, 0, 11),
    new vscode.Selection(1, 6, 1, 10),
  ];

  await vscode.commands.executeCommand("jcode.explainSelection");
  const prompt = await waitFor(async () => {
    try {
      const content = await fs.readFile(stdinLog, "utf8");
      return content.includes("Explain this selected code") ? content : undefined;
    } catch {
      return undefined;
    }
  }, "selection prompt to reach the terminal process");

  assert.match(prompt, /sample\.js/);
  const contextMatch = prompt.match(/Read the exact selection and range metadata from ("(?:[^"\\]|\\.)+")/);
  assert.ok(contextMatch, "prompt must include a JSON-quoted context path");
  const contextPath = JSON.parse(contextMatch[1]);
  const contextText = await fs.readFile(contextPath, "utf8");
  assert.match(contextText, /- Dirty: true/);
  assert.match(contextText, /Selection 1 \(L1:C7-L1:C12\)[\s\S]*alpha/);
  assert.match(contextText, /Selection 2 \(L2:C7-L2:C11\)[\s\S]*beta/);

  const argsText = await fs.readFile(argsLog, "utf8");
  const invocations = argsText.trim().split("\n").map((line) => line.split("\0"));
  const firstArgs = invocations[0];
  assert.deepEqual(firstArgs.slice(-2), ["--provider", "test-provider"]);
  assert.ok(firstArgs.includes("-C"));
  assert.ok(firstArgs.includes(scratch));
  assert.deepEqual(invocations[1], ["transcript", "--mode", "send"]);

  const sentLength = prompt.length;
  editor.selections = [new vscode.Selection(0, 0, 0, 0)];
  await vscode.commands.executeCommand("jcode.explainSelection");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await fs.readFile(stdinLog, "utf8")).length, sentLength);

  await updateSetting("maxSelectionCharacters", 1000);
  const largeDocument = await vscode.workspace.openTextDocument({
    language: "text",
    content: "x".repeat(1200),
  });
  const largeEditor = await vscode.window.showTextDocument(largeDocument);
  largeEditor.selection = new vscode.Selection(0, 0, 0, 1200);
  await vscode.commands.executeCommand("jcode.fixSelection");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await fs.readFile(stdinLog, "utf8")).length, sentLength);

  const firstTerminal = vscode.window.terminals.find((terminal) => terminal.name === "Jcode");
  assert.ok(firstTerminal, "Jcode terminal must be visible to VS Code");
  firstTerminal.dispose();
  await waitFor(
    () => !vscode.window.terminals.includes(firstTerminal),
    "disposed terminal to close",
  );
  await vscode.commands.executeCommand("jcode.open");
  await waitFor(async () => {
    const invocations = (await fs.readFile(argsLog, "utf8")).trim().split("\n");
    return invocations.length >= 3;
  }, "terminal to restart after disposal");

  const restarted = vscode.window.terminals.find((terminal) => terminal.name === "Jcode");
  restarted?.dispose();
  await waitFor(() => !vscode.window.terminals.includes(restarted), "restarted terminal to close");

  await updateSetting("executablePath", "jcode");
  await updateSetting("launchArguments", ["--no-update"]);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("jcode.open");
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

  await updateSetting("executablePath", undefined);
  await updateSetting("launchArguments", undefined);
  await updateSetting("maxSelectionCharacters", undefined);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await fs.rm(scratch, { recursive: true, force: true });

  console.log("JCODE_VSCODE_ACCEPTANCE: PASS");
}

module.exports = { run };
