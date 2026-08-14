# Jcode for VS Code

This repository contains a VS Code extension for Jcode. It adds a native Chat view
to the Activity Bar, can launch the full Jcode TUI in VS Code's integrated terminal,
and lets the user explicitly send editor selections to the agent.

## What works

- The Jcode icon in the Activity Bar opens a native sidebar Chat page.
- `Jcode: Open Chat` focuses the Chat page. `Jcode: Open Terminal Agent` starts the
  full Jcode TUI in the current workspace.
- The Chat page supports multi-turn sessions, New Chat, cancellation, live streaming
  replies, workspace prompts, and an optional current-selection attachment.
- The composer supports file and image attachments, removable attachment chips, and
  direct clipboard image paste. Images use the SDK's native attachment field; other
  files are shared as exact local paths for Jcode to read.
- Type `/` for command autocomplete backed by the full TUI slash-command catalog
  (from jcode's `REGISTERED_COMMANDS`). Commands run in five ways: **native**
  (SDK operations like `/model`, `/effort`, `/clear`, `/compact`, `/rewind`,
  `/rename`, `/info`, `/resume` session picker), **prompt** (the same synthetic
  user-turn templates the TUI uses, e.g. `/commit`, `/plan`, `/fix`, `/test`),
  **cli** (`jcode <subcommand>` output cards, e.g. `/usage`, `/memory`,
  `/telemetry`, `/version`), **local** (extension state, e.g. `/save`,
  `/unsave` bookmarks, `/config`), and **terminal** (opens the terminal agent
  with the command prefilled, e.g. `/login`, `/update`, `/permissions`). Prefix
  a prompt with `//` when it must begin with a literal `/`.
- The sidebar chat renders streaming text, collapsible reasoning, tool-call
  rows, token usage, and sanitized GitHub-flavored Markdown including headings,
  lists, links, blockquotes, tables, inline code, and fenced code blocks. Compact
  composer icons mirror Todo, confidence,
  session KV-cache, and context status; clicking an icon opens the detailed
  Todo and metrics popover. State is retained per session and context-window
  inference follows Jcode's model-family defaults (overridable with
  `jcode.contextWindowTokens`). Permission requests are surfaced when the bridge
  advertises the `permissions` capability.
- With `jcode.shareEditorContext` (default on), each message includes a compact
  summary of the active editor, selection, open files, dirty files, and
  workspace root, so the agent knows what you are looking at in VS Code.
- `Jcode: Run Connection Diagnostics` (or `/diagnose` in the output channel)
  prints executable, socket, protocol, provider, and session information.
- The webview UI lives in `media/` (external `chat.js` / `style.css`, loaded via
  `webview.asWebviewUri`), so its syntax is checked by `npm run check` and
  `npm run check:webview` instead of failing silently at runtime.
- The Chat page uses a compact Claude Code-inspired layout with a floating composer,
  starter prompts, attachment chips, command cards, and live connection status.
- The Chat page has a VS Code native Quick Pick populated from Jcode's live
  `getRuntimeInfo().providers/routes` catalog and grouped by the actual route
  provider. Duplicate model names remain separate when they use different auth or
  API routes, unavailable routes are labelled, and selection sends Jcode's exact
  routed model spec (`claude-api:`, `openai-oauth:`, OpenRouter `@provider`, or an
  OpenAI-compatible profile) instead of an inferred model name. A reasoning-effort
  selector supports `none` … `max`, subject to what the provider accepts. Choices
  persist per workspace and are applied through the Jcode SDK (`listModels` /
  `getRuntimeInfo` / `setModel` / `setReasoningEffort`), and to the terminal agent
  through `-m` and the reasoning-effort environment variables.
- Select code and press `Ctrl+Shift+J` (`Cmd+Shift+J` on macOS) to attach it and focus Chat.
- The editor context menu includes ask, explain, and fix commands.
- Multiple selections are supported.
- Unsaved selected text is supported. The extension writes an exact local snapshot
  under VS Code extension storage and tells Jcode to read it.
- Sidebar prompts run over the Jcode harness API (protocol v1) through the official
  [`@1jehuang/jcode-sdk`](https://jcode.sh/sdk). The extension connects to the
  `jcode api-bridge` socket, starting the bridge automatically when it is not
  already running, and shares the user's live Jcode sessions.
- Selection content is only shared after an explicit command. It is not captured or
  transmitted continuously.

## Requirements

1. Install Jcode and ensure `jcode` is on `PATH`.
2. Run `jcode` once in a terminal and finish provider authentication.
3. Open this folder in VS Code and press `F5` to launch an Extension Development Host.

The extension has one runtime npm dependency, `@1jehuang/jcode-sdk`. Install it and
package with:

```bash
npm install
npm run package
```

## Acceptance test

`test/acceptance/index.js` runs inside a real VS Code Extension Host. It verifies:

- extension activation and command registration;
- Activity Bar container and Webview view contributions;
- chat sessions over the harness API: session creation, multi-turn reuse, New Chat,
  streaming replies, model and reasoning-effort switching, native slash-command
  routing (including in-flight `/cancel` and literal slash escaping), image
  attachments, and cancellation (against a fake bridge that speaks the SDK protocol);
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

## Troubleshooting

If the chat stays on "Connecting…" or a message fails to send:

1. Open the **Output** panel (`View → Output`) and pick the **Jcode** channel. It
   logs every connection step: SDK loading, bridge startup (with the bridge's own
   stderr), socket dialing, and chat send failures.
2. If the bridge fails to start, the log shows why. Common causes:
   - `jcode` is not on `PATH` and not in a probed location
     (`~/.local/bin`, `~/.jcode/builds/current`, `/opt/homebrew/bin`,
     `/usr/local/bin`). Set `jcode.executablePath` to the absolute path.
   - The installed `jcode` is too old for `jcode api-bridge`; update it.
3. The connection has hard timeouts (SDK load 10s, socket dial 5s, session
   restore 45s), so a stuck state always becomes a visible error message.

## Configuration

- `jcode.executablePath`: absolute path or command name for Jcode.
- `jcode.launchArguments`: extra arguments such as `--provider` and a provider name.
- `jcode.maxSelectionCharacters`: safety limit for selection snapshots.
- `jcode.defaultModel`: default model applied to new Jcode chat sessions and the
  terminal agent, e.g. `deepseek-v4-pro`. The sidebar chat model picker overrides
  this per workspace.
- `jcode.models`: fallback model names for the sidebar model picker when Jcode's
  live model catalog is unreachable. When empty, a built-in curated list is used.
- `jcode.defaultEffort`: default reasoning effort (`none`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`; the accepted set depends on the provider).
  Applied to new chat sessions through the SDK's `setReasoningEffort` and passed
  to the terminal agent through the `JCODE_OPENAI_REASONING_EFFORT` /
  `JCODE_ANTHROPIC_REASONING_EFFORT` environment variables.
- `jcode.apiSocketPath`: override the harness API socket path the extension
  connects to and starts the bridge on. Defaults to the extension's global
  storage; `JCODE_API_SOCKET` (environment variable) wins over this setting.
- `jcode.autoApprove`: automatically allow permission prompts issued by the
  agent. Currently a no-op because the bridge does not yet advertise the
  `permissions` capability.
- `jcode.shareEditorContext`: include the active editor / open files summary in
  each sidebar message.
- `JCODE_API_SOCKET` (environment variable): overrides the harness API socket path
  the extension connects to and starts the bridge on.

Example `settings.json`:

```json
{
  "jcode.executablePath": "/usr/local/bin/jcode",
  "jcode.launchArguments": ["--provider", "openai"],
  "jcode.models": ["deepseek-v4-flash", "deepseek-v4-pro", "claude-opus-4-6"],
  "jcode.defaultEffort": "medium"
}
```

## Architecture

The sidebar chats with Jcode over the stable harness API (protocol v1) through the
official TypeScript SDK. The extension connects to the user's `jcode api-bridge`
(autostarting it if needed), creates or resumes a per-workspace session, lists the
real model catalog for the picker, streams `text_delta` events into the Chat page,
sends image attachments through `run(..., { images })`, and maps supported slash
commands to SDK methods such as `setModel`, `setReasoningEffort`, `clear`, `compact`,
and `renameSession`. The terminal agent uses the public `jcode` CLI so it gets the
full interactive TUI command surface.
