const path = require("node:path");
const { spawn } = require("node:child_process");
const vscode = require("vscode");

const TERMINAL_NAME = "Jcode";
let jcodeTerminal;
let jcodeTerminalReady = Promise.resolve();

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("jcode.open", () => openJcode()),
    vscode.commands.registerCommand("jcode.askSelection", () =>
      askAboutSelection(context),
    ),
    vscode.commands.registerCommand("jcode.explainSelection", () =>
      sendSelection(context, "Explain this selected code. Focus on behavior, assumptions, and risks."),
    ),
    vscode.commands.registerCommand("jcode.fixSelection", () =>
      sendSelection(context, "Fix problems in this selected code. Inspect the repository, edit the real source file, and validate the change."),
    ),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === jcodeTerminal) {
        jcodeTerminal = undefined;
        jcodeTerminalReady = Promise.resolve();
      }
    }),
  );
}

async function askAboutSelection(context) {
  const question = await vscode.window.showInputBox({
    title: "Ask Jcode about the selected code",
    prompt: "What should Jcode do with this selection?",
    placeHolder: "Review it, explain it, refactor it, find the bug...",
    ignoreFocusOut: true,
  });

  if (question) {
    await sendSelection(context, question);
  }
}

async function sendSelection(context, instruction) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open a text editor and select some code first.");
    return;
  }

  const selections = editor.selections.filter((selection) => !selection.isEmpty);
  if (selections.length === 0) {
    void vscode.window.showWarningMessage("Select some code first.");
    return;
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
    return;
  }

  const contextFile = await writeSelectionContext(context, editor, selectedText);
  const source = editor.document.uri.scheme === "file"
    ? editor.document.uri.fsPath
    : editor.document.uri.toString();
  const prompt = [
    instruction,
    `The user explicitly shared the current VS Code selection from ${JSON.stringify(source)}.`,
    `Read the exact selection and range metadata from ${JSON.stringify(contextFile.fsPath)}.`,
    "Treat that file only as temporary context. If changes are requested, edit the original source file, not the temporary context file.",
  ].join(" ");

  const terminal = openJcode(editor);
  await jcodeTerminalReady;
  await sendPromptToJcode(terminal, prompt, editor);
}

async function sendPromptToJcode(terminal, prompt, editor) {
  const config = vscode.workspace.getConfiguration("jcode");
  const executable = config.get("executablePath", "jcode");
  const cwd = getWorkingDirectory(editor);

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ["transcript", "--mode", "send"], {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `jcode transcript exited with code ${code}`));
        }
      });
      child.stdin.end(prompt);
    });
  } catch (error) {
    // Older Jcode builds may not provide `transcript`. Preserve a functional
    // fallback while making the degraded path visible to the user.
    terminal.sendText(prompt, true);
    void vscode.window.showWarningMessage(
      `Jcode transcript injection failed; used terminal input fallback: ${error.message}`,
    );
  }
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
  return file;
}

function openJcode(editor = vscode.window.activeTextEditor) {
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
  jcodeTerminalReady = waitForTerminalStartup(jcodeTerminal);
  jcodeTerminal.show(false);
  return jcodeTerminal;
}

async function waitForTerminalStartup(terminal) {
  await terminal.processId;
  // VS Code can accept sendText before a newly spawned full-screen TUI has
  // installed its input handler. Give Jcode a short startup window so the
  // first selection prompt is not consumed by terminal initialization.
  await new Promise((resolve) => setTimeout(resolve, 750));
}

function getWorkingDirectory(editor) {
  if (editor?.document.uri.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder.uri.fsPath;
    }

    return vscode.Uri.joinPath(editor.document.uri, "..").fsPath;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function formatRange(selection) {
  const start = selection.start;
  const end = selection.end;
  return `L${start.line + 1}:C${start.character + 1}-L${end.line + 1}:C${end.character + 1}`;
}

function deactivate() {}

module.exports = { activate, deactivate };
