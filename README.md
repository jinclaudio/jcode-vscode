# Jcode for VS Code

This repository contains a dependency-free VS Code extension for Jcode. It adds a
native Chat view to the Activity Bar, can launch the full Jcode TUI in VS Code's
integrated terminal, and lets the user explicitly send editor selections to the agent.

## What works

- The Jcode icon in the Activity Bar opens a native sidebar Chat page.
- `Jcode: Open Chat` focuses the Chat page. `Jcode: Open Terminal Agent` starts the
  full Jcode TUI in the current workspace.
- The Chat page supports multi-turn sessions, New Chat, cancellation, workspace
  prompts, and an optional current-selection attachment.
- Select code and press `Ctrl+Shift+J` (`Cmd+Shift+J` on macOS) to attach it and focus Chat.
- The editor context menu includes ask, explain, and fix commands.
- Multiple selections are supported.
- Unsaved selected text is supported. The extension writes an exact local snapshot
  under VS Code extension storage and tells Jcode to read it.
- Sidebar prompts use the stable `jcode run --json` CLI boundary. The returned session
  ID is retained in workspace state and passed back with `--resume` for later turns.
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
- Activity Bar container and Webview view contributions;
- Chat process invocation, JSON response handling, session resume, and New Chat;
- active editor and multiple selection capture, including unsaved text;
- exact selection ranges and temporary context-file contents;
- Chat and terminal working directories and configured Jcode arguments;
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

The sidebar currently uses `jcode run --json`, a stable public CLI contract that is
easy to package and test without runtime dependencies. A later version can move to
`jcode acp` and `@agentclientprotocol/sdk` for token-by-token streaming, structured
tool cards, permission prompts, and richer session events. The extension deliberately
does not parse terminal rendering or couple itself to Jcode's internal daemon protocol.
