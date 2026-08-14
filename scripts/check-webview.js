#!/usr/bin/env node
// Guard against the bug that broke 0.5.x: the webview script is generated as a
// giant inline template string, so a syntax error inside it only shows up at
// runtime in the real webview. This script compiles every script block that
// getChatHtml() would emit, plus the external media/chat.js, so syntax errors
// are caught without launching VS Code.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const extensionSource = fs.readFileSync(path.join(root, "extension.js"), "utf8");

let failures = 0;

function checkScript(script, label) {
  const file = path.join(os.tmpdir(), `jcode-webview-check-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(file, script);
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  fs.unlinkSync(file);
  if (result.status !== 0) {
    failures += 1;
    console.error(`SYNTAX ERROR in ${label}:`);
    console.error(result.stderr || result.stdout || "unknown error");
  } else {
    console.log(`OK ${label}`);
  }
}

// 1. External webview client.
checkScript(fs.readFileSync(path.join(root, "media", "chat.js"), "utf8"), "media/chat.js");

// 2. Inline scripts emitted by getChatHtml(). The function is evaluated with a
//    fake webview object; only cspSource and asWebviewUri are used.
const match = extensionSource.match(/function getChatHtml\(webview, context\) \{([\s\S]*?)\n\}\n\s*function getNonce\(\)/);
if (!match) {
  console.error("FAIL: getChatHtml(webview, context) not found in extension.js");
  process.exit(1);
}
const getChatHtml = new Function(
  "webview",
  "context",
  "vscode",
  match[1] + "\nfunction getNonce() { return 'nonce-check'; } return getChatHtml(webview, context);",
);
const html = getChatHtml(
  {
    cspSource: "vscode-webview://check",
    asWebviewUri: (uri) => uri,
  },
  {
    extensionUri: { fsPath: root },
  },
  {
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }),
    },
  },
);
const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/g;
let scriptMatch;
let found = 0;
while ((scriptMatch = scriptPattern.exec(html)) !== null) {
  found += 1;
  checkScript(scriptMatch[1], `inline script #${found}`);
}
if (found === 0) {
  console.error("FAIL: no inline script blocks found in generated HTML");
  process.exit(1);
}
if (!html.includes('<select id="model"')) {
  console.error('FAIL: generated HTML must include <select id="model">');
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n${failures} script(s) failed syntax check.`);
  process.exit(1);
}
console.log("\nWebview scripts: all syntax checks passed.");
