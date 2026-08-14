#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-vscode-acceptance-host-"));
const marker = path.join(scratch, "result.txt");
const userDataDir = path.join(scratch, "user-data");
const extensionsDir = path.join(scratch, "extensions");
const timeoutMs = 120_000;

try { fs.rmSync(marker, { force: true }); } catch {}

const child = spawn("code", [
  "--new-window",
  "--wait",
  "--user-data-dir", userDataDir,
  "--extensions-dir", extensionsDir,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(root, "test/acceptance/index.js")}`,
], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JCODE_VSCODE_ACCEPTANCE_MARKER: marker } });

// Do not let an orphaned VS Code CLI inherit the caller's stdout/stderr file
// descriptors. On macOS `code --wait` can outlive the extension-test runner;
// inherited descriptors then keep CI/background tasks open even after PASS.
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

const started = Date.now();
let finished = false;

function finish(code, message) {
  if (finished) return;
  finished = true;
  if (message) console.error(message);
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }, 250);
}

child.on("error", (error) => finish(1, `Could not launch VS Code: ${error.message}`));
child.on("exit", (code) => {
  if (finished) return;
  if (!fs.existsSync(marker)) finish(code || 1, "VS Code exited without producing an acceptance result.");
});

const timer = setInterval(() => {
  if (finished) return clearInterval(timer);
  if (fs.existsSync(marker)) {
    const result = fs.readFileSync(marker, "utf8").trim();
    console.log(`JCODE_VSCODE_ACCEPTANCE_RESULT: ${result.split("\n", 1)[0]}`);
    clearInterval(timer);
    finish(result === "PASS" ? 0 : 1, result === "PASS" ? undefined : result);
  } else if (Date.now() - started > timeoutMs) {
    clearInterval(timer);
    finish(1, `Acceptance timed out after ${timeoutMs / 1000}s without a result marker.`);
  }
}, 250);
