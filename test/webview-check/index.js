// Extension Host test: open the REAL Jcode webview and verify the full
// ready -> bootstrap -> restore flow completes in a real exthost.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "claudioj.jcode-vscode";
const VIEW_ID = "jcode.chatView";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const resultMarker = process.env.JCODE_VSCODE_ACCEPTANCE_MARKER || path.join(os.tmpdir(), "jcode-webview-check-result.txt");
  try { fs.unlinkSync(resultMarker); } catch {}

  console.log("WV: test started");
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) {
    fs.writeFileSync(resultMarker, "FAIL\nextension not found\n");
    return;
  }
  await extension.activate();
  console.log("WV: extension activated");

  const stateBefore = await vscode.commands.executeCommand("jcode._test.getChatState");
  console.log("WV: state before:", JSON.stringify(stateBefore));

  // Focus the real webview view in the sidebar.
  try {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    console.log("WV: view focused");
  } catch (error) {
    fs.writeFileSync(resultMarker, `FAIL\nfocus threw: ${error?.stack || error}\n`);
    return;
  }

  // Give the webview time to load, post ready, and run restoreChat
  // (bridge startup can take a few seconds).
  const deadline = Date.now() + 45000;
  let state;
  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      state = await vscode.commands.executeCommand("jcode._test.getChatState");
    } catch (error) {
      console.log("WV: getChatState threw:", error?.stack || error);
    }
    if (state && state.sessionId) {
      console.log("WV: session established:", JSON.stringify(state));
      break;
    }
  }
  console.log("WV: final state:", JSON.stringify(state));

  const hasSession = Boolean(state && state.sessionId);
  if (hasSession) {
    fs.writeFileSync(resultMarker, `PASS\nsession=${state.sessionId}\n`);
    console.log("JCODE_VSCODE_WV: PASS", state.sessionId);
  } else {
    fs.writeFileSync(resultMarker, `FAIL\nstate=${JSON.stringify(state)}\n`);
    console.log("JCODE_VSCODE_WV: FAIL", JSON.stringify(state));
  }
}

module.exports = { run };
