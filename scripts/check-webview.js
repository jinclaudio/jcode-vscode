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
const chatSource = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");

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
checkScript(chatSource, "media/chat.js");

const markedPath = path.join(root, "media", "vendor", "marked.umd.js");
const purifyPath = path.join(root, "media", "vendor", "purify.min.js");
for (const vendorPath of [markedPath, purifyPath]) {
  if (!fs.existsSync(vendorPath) || fs.statSync(vendorPath).size < 1000) {
    console.error(`FAIL: missing or empty webview vendor script ${vendorPath}`);
    process.exit(1);
  }
}
const marked = require(markedPath);
const markdownFixture = marked.parse("## Heading\n\n- one\n- two\n\n`code`");
for (const fragment of ["<h2>Heading</h2>", "<ul>", "<code>code</code>"]) {
  if (!markdownFixture.includes(fragment)) {
    console.error(`FAIL: vendored Markdown parser did not render ${fragment}`);
    process.exit(1);
  }
}
for (const required of ["window.marked.parse", "window.DOMPurify.sanitize", "FORBID_TAGS", "__rawText"]) {
  if (!chatSource.includes(required)) {
    console.error(`FAIL: media/chat.js is missing Markdown safety path ${required}`);
    process.exit(1);
  }
}

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
    asWebviewUri: (uri) => uri.fsPath,
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
if (!html.includes('<button id="model"') || !html.includes('id="model-label"')) {
  console.error('FAIL: generated HTML must include the VS Code model picker button');
  process.exit(1);
}
for (const id of ["runtime-popover", "runtime-indicators", "todo-indicator", "confidence-indicator", "cache-indicator", "context-indicator", "todo-list"]) {
  if (!html.includes(`id="${id}"`)) {
    console.error(`FAIL: generated HTML must include runtime dashboard element #${id}`);
    process.exit(1);
  }
}
for (const panel of ["todo", "confidence", "cache", "context"]) {
  if (!html.includes(`data-runtime-panel="${panel}"`) || !html.includes(`data-runtime-content="${panel}"`)) {
    console.error(`FAIL: runtime icon ${panel} must have its own matching popover content`);
    process.exit(1);
  }
}
for (const required of ["showRuntimePanel", "content.hidden = content.dataset.runtimeContent !== panel", "client.softInterrupt", 'case "steering"']) {
  const source = required === "client.softInterrupt" ? extensionSource : chatSource;
  if (!source.includes(required)) {
    console.error(`FAIL: missing runtime interaction path ${required}`);
    process.exit(1);
  }
}
if (/RUNTIME_DEMO|webviewRuntimeState/.test(extensionSource)) {
  console.error("FAIL: production runtime state must not be replaced with demo metrics");
  process.exit(1);
}
const markedScriptIndex = html.indexOf("/media/vendor/marked.umd.js");
const purifyScriptIndex = html.indexOf("/media/vendor/purify.min.js");
const chatScriptIndex = html.indexOf("/media/chat.js");
if (!(markedScriptIndex >= 0 && markedScriptIndex < purifyScriptIndex && purifyScriptIndex < chatScriptIndex)) {
  console.error("FAIL: Markdown parser and sanitizer must load before media/chat.js");
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n${failures} script(s) failed syntax check.`);
  process.exit(1);
}
console.log("\nWebview scripts: all syntax checks passed.");
