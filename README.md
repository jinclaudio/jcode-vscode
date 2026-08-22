# Jcode for VS Code — AI Coding Agent Extension

Jcode for VS Code is a Visual Studio Code extension that brings the Jcode AI coding
agent directly into VS Code. It provides a native sidebar chat, editor context,
multi-turn sessions, slash commands, model selection, and full Jcode terminal
integration.

The extension talks to Jcode through its Agent Client Protocol (ACP) adapter
(`jcode acp`), a JSON-RPC 2.0 stdio transport. It shares the user's live Jcode
sessions, so conversations started in the sidebar are the same ones the terminal
TUI shows, and vice versa.

## What works

- The Jcode icon in the Activity Bar opens a native sidebar Chat page.
- `Jcode: Open Chat` focuses the Chat page. `Jcode: Open Terminal Agent` starts the
  full Jcode TUI in the current workspace.
- The conversation title in the Chat header opens a session switcher. Select any
  Jcode session to replace the visible transcript with that session's history and
  continue talking in it directly. New Chat starts a separate conversation without
  mixing messages from the previous session.
- The Chat page supports multi-turn sessions, cancellation, live streaming replies,
  workspace prompts, and an optional current-selection attachment.
- The Parallel tasks dashboard runs multiple Jcode sessions at once. Each worker has
  its own prompt, status, output, model, effort, and cancellation control. A bounded
  queue enforces `jcode.multiSession.maxConcurrent`, dependencies delay downstream
  work, and read-only coordinator tasks synthesize completed worker results.
- Editable tasks default to isolated Git worktrees and `jcode/<task>` branches. The
  dashboard can show each task diff, commit isolated changes, cherry-pick completed
  commits into a clean main worktree, abort conflicts safely, and remove worktrees.
  Shared-workspace and read-only modes are also available for tasks that do not need
  branch isolation.
- The composer supports file and image attachments, removable attachment chips, and
  direct clipboard image paste. Images use ACP image content blocks; other files are
  shared as exact local paths for Jcode to read.
- Type `/` for command autocomplete backed by the full TUI slash-command catalog
  (from jcode's `REGISTERED_COMMANDS`). Commands run in five ways: **native**
  (ACP operations like `/model`, `/effort`, `/clear`, `/compact`, `/rewind`,
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
  composer icons mirror Todo, confidence, session KV-cache, and context status;
  clicking an icon opens only that icon's corresponding compact detail panel.
  State is retained per session and context-window
  inference follows Jcode's model-family defaults (overridable with
  `jcode.contextWindowTokens`). Permission requests surface as a VS Code dialog
  unless `jcode.autoApprove` is enabled.
- With `jcode.shareEditorContext` (default on), each message includes a compact
  summary of the active editor, selection, open files, dirty files, and
  workspace root, so the agent knows what you are looking at in VS Code.
- The separate stop button cancels the active response.
- `Jcode: Run Connection Diagnostics` (or `/diagnose` in the output channel)
  prints executable, protocol, provider, and session information.
- The webview UI lives in `media/` (external `chat.js` / `style.css`, loaded via
  `webview.asWebviewUri`), so its syntax is checked by `npm run check` and
  `npm run check:webview` instead of failing silently at runtime.
- The Chat page uses a compact Claude Code-inspired layout with a floating composer,
  starter prompts, attachment chips, command cards, and live connection status.
- The Chat page has a VS Code native Quick Pick populated from Jcode's live model
  catalog (`session/new` config options) grouped by provider. A reasoning-effort
  selector supports `none` … `max`, subject to what the provider accepts. Choices
  persist per workspace and are applied through the ACP `session/set_config_option`
  method, and to the terminal agent through `-m` and the reasoning-effort
  environment variables.
- Select code and press `Ctrl+Shift+J` (`Cmd+Shift+J` on macOS) to attach it and focus Chat.
- The editor context menu includes ask, explain, and fix commands.
- Multiple selections are supported.
- Unsaved selected text is supported. The extension writes an exact local snapshot
  under VS Code extension storage and tells Jcode to read it.
- Sidebar prompts run over the ACP protocol (v1) through the `jcode acp` adapter.
  The extension starts the adapter automatically when needed and shares the user's
  live Jcode sessions.
- Selection content is only shared after an explicit command. It is not captured or
  transmitted continuously.

## Requirements

1. Install Jcode v0.79 or newer (the version that replaced `jcode api-bridge` with
   `jcode acp`) and ensure `jcode` is on `PATH`.
2. Run `jcode` once in a terminal and finish provider authentication.
3. Open this folder in VS Code and press `F5` to launch an Extension Development Host.

The extension has no runtime npm dependencies. Package with:

```bash
npm install
npm run package
```

## Acceptance test

`test/acceptance/index.js` runs inside a real VS Code Extension Host. It verifies:

- extension activation and command registration;
- Activity Bar container and Webview view contributions;
- chat sessions over the ACP adapter: session creation, multi-turn reuse, direct
  switching with isolated transcript restoration, New Chat, streaming replies,
  model and reasoning-effort switching, native slash-command routing (including
  in-flight `/cancel` and literal slash escaping), image attachments, and
  cancellation;
- parallel task sessions: concurrent execution, distinct session IDs, independent
  cancellation, queue limits, dependency ordering, and coordinator synthesis;
- Git integration in a temporary real repository: worktree creation, branch isolation,
  commit, clean-main cherry-pick, merged file observation, and worktree cleanup;
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
   logs every connection step: ACP startup (with the adapter's own stderr),
   initialization, and chat send failures.
2. If the adapter fails to start, the log shows why. Common causes:
   - `jcode` is not on `PATH` and not in a probed location
     (`~/.local/bin`, `~/.jcode/builds/current`, `/opt/homebrew/bin`,
     `/usr/local/bin`). Set `jcode.executablePath` to the absolute path.
   - The installed `jcode` is too old for `jcode acp` (need v0.79+); update it.
3. The connection has hard timeouts (ACP startup 15s, session restore 45s), so a
   stuck state always becomes a visible error message.

## Configuration

- `jcode.executablePath`: absolute path or command name for Jcode.
- `jcode.launchArguments`: extra arguments such as `--provider` and a provider name.
- `jcode.maxSelectionCharacters`: safety limit for selection snapshots.
- `jcode.multiSession.enabled`: show and enable the Parallel tasks dashboard.
- `jcode.multiSession.maxConcurrent`: maximum task sessions running at once, from 1 to 12.
- `jcode.multiSession.defaultIsolation`: default new-task mode, `worktree`, `shared`, or
  `read-only`.
- `jcode.multiSession.autoCommit`: automatically commit successful worktree tasks on
  their isolated branch.
- `jcode.defaultModel`: default model applied to new Jcode chat sessions and the
  terminal agent, e.g. `deepseek-v4-pro`. The sidebar chat model picker overrides
  this per workspace.
- `jcode.models`: fallback model names for the sidebar model picker when Jcode's
  live model catalog is unreachable. When empty, a built-in curated list is used.
- `jcode.defaultEffort`: default reasoning effort (`none`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`; the accepted set depends on the provider).
  Applied to new chat sessions through ACP and passed to the terminal agent through
  the `JCODE_OPENAI_REASONING_EFFORT` / `JCODE_ANTHROPIC_REASONING_EFFORT`
  environment variables.
- `jcode.autoApprove`: automatically allow permission prompts issued by the
  agent. When disabled, a VS Code dialog asks you to allow or deny each
  permission request during a turn.
- `jcode.shareEditorContext`: include the active editor / open files summary in
  each sidebar message.

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

The sidebar chats with Jcode over the ACP protocol (v1) through the `jcode acp`
adapter (see `acp-client.js`). The extension starts the adapter automatically if
needed, creates or resumes the primary per-workspace chat session, and gives every
parallel task its own adapter connection and working directory. Session discovery
and history read Jcode's persisted state under `~/.jcode/sessions`. A persisted
`MultiSessionTaskManager` schedules bounded concurrent workers, resolves
dependencies, restores detached task metadata, and publishes task state to the
Webview.

Editable workers use Git worktrees under extension global storage. Diff and commit
run inside the isolated worktree, while merge verifies that the main worktree is
clean and cherry-picks the task branch commits, aborting conflicts. The extension
lists the real model catalog for the picker, streams `agent_message_chunk` text into
the Chat page, sends image attachments through `session/prompt` content blocks, and
maps supported slash commands to ACP methods such as `session/set_config_option`,
`session/prompt` (slash commands), and the `jcode session rename` CLI. The terminal
agent uses the public `jcode` CLI so it gets the full interactive TUI command
surface.
