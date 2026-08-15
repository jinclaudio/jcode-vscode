// Minimal Extension Host test: verify the extension connects through its
// default globalStorage socket path in the real exthost runtime.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "claudioj.jcode-vscode";

async function run() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-mini-connect-"));
  const resultMarker = process.env.JCODE_VSCODE_ACCEPTANCE_MARKER || path.join(os.tmpdir(), "jcode-mini-connect-result.txt");
  try { fs.unlinkSync(resultMarker); } catch {}

  console.log("MINI: test started");
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) {
    await writeFail(resultMarker, "extension not found in exthost");
    return;
  }
  console.log("MINI: extension found:", extension.id);
  await extension.activate();
  console.log("MINI: extension activated, isActive:", extension.isActive);
  const globalStorageUri = extension.globalStorageUri || extension.extensionUri;
  console.log("MINI: globalStorageUri:", globalStorageUri.toString());

  // Do NOT set JCODE_API_SOCKET: exercise the extension's default socket path
  // under its real globalStorage directory (like the user's environment).
  const apiSocket = path.join(globalStorageUri.fsPath, "api.sock");
  console.log("MINI: default api socket path:", apiSocket);
  try { fs.unlinkSync(apiSocket); } catch {}

  // Use the extension's default executable (real jcode).
  await vscode.workspace.getConfiguration("jcode").update("executablePath", "jcode", vscode.ConfigurationTarget.Global);

  try {
    console.log("MINI: sending chat through the extension's real connection path...");
    const result = await vscode.commands.executeCommand(
      "jcode._test.sendChat",
      "Reply with the single word: connected",
      false,
    );
    console.log("MINI: sendChat result:", JSON.stringify(result).slice(0, 200));
    if (result && result.session_id) {
      console.log("MINI: socket after connect:", fs.existsSync(apiSocket));
      await writePass(resultMarker, `session=${result.session_id}`);
    } else {
      await writeFail(resultMarker, `sendChat returned ${JSON.stringify(result)}`);
    }
  } catch (error) {
    await writeFail(resultMarker, `${error?.stack || error}`);
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

async function writePass(marker, extra = "") {
  fs.writeFileSync(marker, `PASS\n${extra}\n`);
  console.log("JCODE_VSCODE_MINI: PASS", extra);
}

async function writeFail(marker, message) {
  fs.writeFileSync(marker, `FAIL\n${message}\n`);
  console.log("JCODE_VSCODE_MINI: FAIL", message);
}

module.exports = { run };
