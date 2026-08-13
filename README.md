# Jcode for VS Code

This repository contains a dependency-free MVP of a VS Code extension for Jcode.
It launches the real Jcode TUI in VS Code's integrated terminal and lets the user
explicitly send one or more editor selections to the agent.

## What works

- `Jcode: Open Agent` starts `jcode` in the current workspace.
- Select code and press `Ctrl+Shift+J` (`Cmd+Shift+J` on macOS) to ask Jcode about it.
- The editor context menu includes ask, explain, and fix commands.
- Multiple selections are supported.
- Unsaved selected text is supported. The extension writes an exact local snapshot
  under VS Code extension storage and tells Jcode to read it.
- Prompts are submitted through Jcode's official `transcript --mode send` interface,
  with terminal input retained as a compatibility fallback for older Jcode builds.
- Selection content is only shared after an explicit command. It is not captured or
  transmitted continuously.

## Requirements

1. Install Jcode and ensure `jcode` is on `PATH`.
2. Run `jcode` once in a terminal and finish provider authentication.
3. Open this folder in VS Code and press `F5` to launch an Extension Development Host.

This MVP is plain JavaScript, so it has no compile step or runtime npm dependencies.
To package it, install Node.js and run:

```bash
npm install
npm run package
```

## Acceptance test

`test/acceptance/index.js` runs inside a real VS Code Extension Host. It verifies:

- extension activation and command registration;
- active editor and multiple selection capture, including unsaved text;
- exact selection ranges and temporary context-file contents;
- terminal working directory and configured Jcode arguments;
- no-selection and oversized-selection safety paths;
- terminal disposal and restart;
- startup of the real `jcode` executable in a VS Code integrated terminal.

Run it from a graphical desktop with:

```bash
npm run test:acceptance
```

On Linux CI, the same test can run under Xvfb by invoking VS Code with
`--extensionDevelopmentPath` and `--extensionTestsPath`.

## Configuration

- `jcode.executablePath`: absolute path or command name for Jcode.
- `jcode.launchArguments`: extra arguments such as `--provider` and a provider name.
- `jcode.maxSelectionCharacters`: safety limit for selection snapshots.

Example `settings.json`:

```json
{
  "jcode.executablePath": "/usr/local/bin/jcode",
  "jcode.launchArguments": ["--provider", "openai"]
}
```

## Architecture roadmap

The terminal MVP deliberately reuses Jcode's mature TUI and permission UI. A native
Codex-style side panel should be the next layer:

1. Spawn `jcode acp -C <workspace>` as a child process.
2. Connect with `@agentclientprotocol/sdk` over NDJSON stdio.
3. Render session updates in a `WebviewViewProvider`.
4. Map ACP permission requests to VS Code modal actions.
5. Implement ACP filesystem callbacks with `vscode.workspace.fs`.
6. Attach editor selections as ACP prompt content instead of temporary files.
7. Persist session IDs in `workspaceState` so chats can resume.

Jcode already exposes the required IDE-facing adapter through `jcode acp`; avoid
parsing terminal output or coupling the extension to Jcode's internal daemon protocol.
