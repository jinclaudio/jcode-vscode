# jcode VS Code 扩展 · 完整重写计划(v1 审核稿)

## 0. 背景:为什么重写

上一版(0.5.x)的根因已定位:**webview 的内联脚本存在语法错误,导致整个脚本从不执行**。
表现:侧边栏打开后 `ready` 消息永远不发出、错误处理器也没注册,界面永远停在 "Connecting…",
也就是用户看到的"连不上 jcode"。后端链路(api-bridge + SDK)本身是通的(已在真实 exthost 验证:建会话、列模型、发消息全部成功)。

重写要点:
- UI 从"巨型内联模板字符串"改为 `media/` 下的独立文件(html/css/js),用 `asWebviewUri` 加载,语法错误可以被 `node --check` 和自动化测试直接拦截。
- 其余保持"完整 wrapper"定位:侧边栏聊天 + 编辑器状态上下文 + jcode 全部能力。

---

## 1. 对接架构(核心决策)

### 1.1 jcode 侧:harness API + `api-bridge`(稳定协议 v1)

| 项目 | 选择 | 理由 |
|---|---|---|
| 协议 | harness API,protocol v1,NDJSON over Unix socket | 官方稳定边界,`@1jehuang/jcode-sdk` 与 Rust 侧双向 schema 防漂移测试 |
| 入口 | `jcode api-bridge [--api-socket <path>]` | 随发布二进制内置,无需 Rust 工具链;官方文档明确"编辑器插件用这个" |
| 模式 | **`JcodeClient.connect()`**(连接用户自己的 jcode) | 与用户终端 TUI **共享同一批会话**;扩展里做的每件事在终端里可见,反之亦然。这是 Claude Code / Codex 插件的定位 |
| 不用 | `JcodeClient.launch()`(私有实例) | 那是给"把 jcode 当产品引擎嵌入"的场景;会另起 daemon、另建状态目录,与用户终端互相看不见,不符合 wrapper 定位 |
| 桥的生命周期 | 扩展按需启动(检测 socket 不存在 → `spawn(jcode, ["--no-update","api-bridge","--api-socket",...])`,detached);若已运行则直接 connect | 用户不需要手动起桥 |
| socket 路径 | 默认 SDK 运行时路径;可用 `jcode.apiSocketPath` 配置覆盖;环境变量 `JCODE_API_SOCKET` 优先 | 与官方 SDK 约定一致 |
| 客户端身份 | `clientName: "jcode-vscode/<version>"` | 握手时上报,便于排查 |

### 1.2 SDK:官方 `@1jehuang/jcode-sdk`(随扩展打包,无需网络)

```
node_modules/@1jehuang/jcode-sdk  (v1.1.0,与协议 v1 配套)
```

连接失败码按 `HarnessError.code` 分支(`connect_failed` / `unsupported_version` / `unknown_session` / `disconnected` / `timeout`...),
文档给的恢复策略直接落地:
- `connect_failed` → 起桥重试(带 15s 超时,失败给出诊断命令 `jcode.diagnose`);
- `disconnected` → 自动重连并 `attachSession` 恢复;
- `unsupported_version` → 提示升级 jcode 或扩展。

### 1.3 VS Code 侧:API 面(全部为稳定 API,无 proposed API)

| 用途 | VS Code API |
|---|---|
| 侧边栏聊天 | `window.registerWebviewViewProvider("jcode.chatView")` + `retainContextWhenHidden: true` |
| webview 资源 | `webview.asWebviewUri(mediaUri)` 加载 `chat.js` / `style.css`;CSP 用 nonce + `cspSource`,**脚本放外部文件** |
| 编辑器状态 | `window.activeTextEditor` / `onDidChangeActiveTextEditor` / `onDidChangeTextEditorSelection` / `workspace.textDocuments`(打开标签页)/ `onDidOpenTextDocument` / `onDidCloseTextDocument` / `onDidSaveTextDocument` / `TextDocument.isDirty` |
| 工作区 | `workspace.workspaceFolders`(会话 workingDir 默认取 workspace 根) |
| 终端 agent | `window.createTerminal({ shellPath: jcode, args, cwd })` + `terminal.sendText`(完整 TUI 兜底) |
| 命令 & 菜单 | `commands.registerCommand` + package.json `contributes.commands` / `menus`(editor/context:Explain/Fix/Ask) |
| 状态栏 | `window.createStatusBarItem`(连接状态 / 当前模型 / 运行中) |
| 配置 | `workspace.getConfiguration("jcode")` |
| 日志 | `window.createOutputChannel("Jcode")` + `jcode.diagnose` 命令 |
| 通知 | `window.showErrorMessage` / `showInformationMessage`(连接失败、权限等) |

---

## 2. 功能清单(完整 wrapper):功能 → API 映射

### 2.1 聊天(核心)
| 功能 | SDK 方法 / 事件 | 说明 |
|---|---|---|
| 发送消息 | `sendMessage(sessionId, text, { images })` | 返回后不阻塞,走事件流 |
| 流式输出 | `events(sessionId)` 消费:`text_delta` / `reasoning_delta` / `reasoning_done` / `tool_start` / `tool_input_delta` / `tool_exec` / `tool_done` / `token_usage` / `message_accepted` / `turn_done` | UI:正文流式渲染;推理折叠块;工具调用列表(名称/参数/输出/错误);token 统计 |
| 取消 | `cancel(sessionId)` | 立即停 |
| 软中断 | `softInterrupt(sessionId, text, urgent?)` | 在安全点注入指令;`cancelSoftInterrupts` 撤回 |
| 上下文-only 消息 | `sendMessage(..., { noReply: true })` | 用于"把 VS Code 状态写进上下文,不触发回合" |

### 2.2 会话管理
| 功能 | SDK 方法 | 说明 |
|---|---|---|
| 会话列表/切换 | `listSessions({ includeArchived })` + `attachSession` / `detachSession` | 侧边栏会话切换器,显示标题/工作目录/状态 |
| 预览 | `peekSession(id, limit)` | 切换器悬停预览,**不打扰**会话 |
| 新建 | `createSession(workingDir)` | workingDir = 当前 workspace 根 |
| 重命名 | `renameSession(id, title?)` | |
| 归档/恢复 | `archiveSession` / `restoreSession` / `setRetentionPolicy(days?)` | 设置页 UI |
| 历史编辑 | `clear` / `rewind(id, index)` / `rewindUndo` | 斜杠命令 + UI 入口 |
| 压缩 | `compact(id)` | 拒绝时把原因(`invalid_request` 的 message)当提示展示 |
| 恢复会话 | `getHistory(id)` 回填聊天 UI | 窗口重载/切换会话时 |
| 全局监视 | `globalEvents()` | 会话切换器实时状态(可选增强) |

### 2.3 模型 & 推理
| 功能 | SDK 方法 / 事件 |
|---|---|
| 模型下拉 | `listModels(sessionId)` → `{ models, current }`(attach 时 daemon 推送,零往返) |
| 切换模型 | `setModel(id, model)`;失败(`invalid_request`)保留上次有效值并提示 |
| 模型变更广播 | `model_info` 事件(别的客户端改了也同步 UI) |
| 推理努力度 | `setReasoningEffort(id, effort)`(per-provider,直接透传字符串) |

### 2.4 权限 & 工具透明
| 功能 | SDK | 说明 |
|---|---|---|
| 权限审批 UI | `permission_request` 事件 → `respondToPermission(id, requestId, "allow"\|"allow_always"\|"deny")` | UI 就绪;**当前 bridge 不宣告 `permissions` capability(官方文档注明),因此先以 `client.supports("permissions")` 探测,有才等事件**;没有时展示工具调用流(tool_start/tool_done)代替 |
| 自动批准开关 | `sendMessage` 不传 autoApprove;配置 `jcode.autoApprove` 决定是否在事件回调里自动回 `allow` | 默认关闭,保持人工确认 |

### 2.5 附件
| 功能 | 实现 |
|---|---|
| 粘贴图片 | webview 读取 → base64 → `sendMessage(id, text, [[mediaType, data]])` |
| 文件附件 | 扩展读文件内容,拼进 prompt(路径+内容摘要),并注明来源 |

### 2.6 运行时 & 凭据
| 功能 | SDK 方法 | 说明 |
|---|---|---|
| 状态/健康 | `getRuntimeInfo(id)`(server / protocolVersion / capabilities / provider / model / routes / healthy)+ `ping()` | 状态栏 + diagnose 输出 |
| API Key | `setApiKey(provider, key)` / `clearApiKey(provider)` | 设置页(可选,二期) |
| 会话内文件访问 | `readFile` / `findFiles` / `searchText` / `fileStatus`(受工作目录约束) | 供"在 jcode 里打开/搜索"命令(二期) |

---

## 3. TUI 斜杠命令全集接入

从 jcode 源码(`crates/jcode-tui/.../state_ui_input_helpers.rs`,`v0.76.0`)提取了 TUI 全部
`REGISTERED_COMMANDS`(~110 条,含别名)。**全部可接入**,按机制分五层;命令目录本身直接
内嵌这份注册表(名称+说明),保证与 TUI 同步、版本可查。

### 三层实现机制 + 两层兜底

| 层 | 机制 | 对应 API | 命令 |
|---|---|---|---|
| **T1 原生** | 侧边栏直接调 SDK | `listModels`/`setModel`/`setReasoningEffort`/`cancel`/`clear`/`rewind`/`compact`/`renameSession`/`listSessions`+`attachSession`/`getRuntimeInfo`/`getHistory`/`peekSession` | `/model` `/models` `/effort` `/cancel` `/clear` `/rewind` `/compact` `/info` `/rename` `/resume` `/sessions` `/session` `/context`(历史摘要) |
| **T2 提示词** | 与 TUI **同一机制**:`build_xxx_prompt()` 模板 + 合成用户回合 → `sendMessage(sessionId, prompt)`。模板从源码提取复用 | `sendMessage` + 事件流 | `/commit` `/commit-push` `/plan` `/improve` `/refactor` `/fix` `/test` `/todos` `/poke` `/review` `/judge` `/autoreview` `/autojudge` `/initiatives` `/goals` `/btw`(侧栏本地实现) `/observe`(近似) `/overnight` `/swarm`(大流程,可选) |
| **T3 CLI 桥接** | 扩展 spawn `jcode <subcommand>`,输出进命令面板/终端 | child_process + 输出通道 | `/usage`→`jcode usage`;`/login` `/logout` `/auth` `/account` → `jcode login/account/auth`(浏览器流程优先开终端);`/memory`→`jcode memory`;`/telemetry`→`jcode telemetry`;`/version`→`jcode version`;`/update`→`jcode update`(提示终端执行);`/provider-test-coverage` `/model-status`→`jcode provider-test-coverage`;`/refresh-model-list`→`jcode model refresh`;`/transcript`→定位并打开 transcript 文件;`/dictate`→`jcode dictate`(可选) |
| **T4 本地 UI** | 扩展自管状态 | `workspaceState` / `vscode.open` | `/save` `/unsave`(书签置顶,SDK 不暴露,本地存) `/config`(打开 VS Code settings.json + jcode 配置) `/cls`(清本地视图) `/keys` `/hotkeys` `/colors` `/changelog`(扩展内帮助页,可选) |
| **T5 终端兜底** | "Open in Terminal Agent" 预填命令 | `createTerminal` + `sendText` | 纯 TUI 绘制(`/diff` `/thinking-display` `/tool-call-details` `/show-agentgrep-output` `/compact-notifications` `/alignment` `/fast` `/transport` `/terminal-setup` `/screenshot*` `/record` `/debug-*` `/onboarding-*`)、二进制生命周期(`/reload` `/restart` `/rebuild` `/selfdev` `/update`)、远程(`/remote` `/client-reload` `/server-reload` `/continue` `/resumeall`)、自研发布(`/fast-release` `/fast-macos-release` `/remote-release` `/triage`)、`/help` `/?` `/commands`(扩展自带 help UI,数据同源)、`/quit`(无意义,禁用) |

### 侧边栏交互设计

- 输入框输入 `/` 弹出命令补全,数据 = 上表五层合并目录,带**层级徽标**(原生 / 提示词 / CLI / 本地 / 终端)。
- T1/T2/T4 直接执行,结果进聊天流;T3 输出进"命令输出"面板(可折叠);T5 一键打开终端 agent 并预填命令。
- `/resume` 会话选择器与 2.2 会话管理共用同一 UI。

---

## 4. 编辑器状态 → jcode 上下文(本需求的核心)

**"获取当前 VS Code 文件打开状态"** 落地为三层:

1. **选择桥(保留并修复)**
   - 命令:`Ask Jcode`(暂存选择)、`Explain Selection`、`Fix Selection`(editor/context 菜单 + 快捷键)。
   - 机制:选中内容写入临时快照文件(`selection-*.md`,含 dirty 标记、选区范围、行号),prompt 里带 JSON 引用的路径,让 agent 读精确内容;快照按数量+大小双重上限(旧版已实现,验收测试覆盖,保留)。
   - 超限保护:`jcode.maxSelectionCharacters` 超长直接拒绝并提示。

2. **编辑器上下文自动注入(新增)**
   - 扩展持续维护一份轻量"编辑器状态":活动文件路径、当前选区、打开标签页列表、dirty 文件、workspace 根。
   - 配置 `jcode.shareEditorContext`(默认开):每次发送用户消息时,把**紧凑摘要**(活动文件 + 选区位置 + 打开文件数/列表 + dirty 文件)作为前缀注入 prompt;大列表截断。
   - 可选:`noReply` 上下文消息在会话开始时写入一次"当前打开的文件"基线,不触发模型回合。

3. **工作目录对齐**
   - `createSession(workspaceRoot)`:agent 的 workingDir 与 VS Code 工作区一致,agent 可自行读文件;扩展负责把"用户在看的文件"指给 agent(第 1、2 层)。

---

## 5. 连接生命周期(状态机)

```
idle
 └─ 首次需要 → connect()
     ├─ connect_failed → spawnBridge() → 轮询重连(15s 超时)→ 失败给 diagnose 指引
     ├─ connected → watchLiveness(client.on("close")) → 断线自动重连 + attachSession 恢复
     └─ unsupported_version / handshake_failed → 提示升级,不无限重试
```

- 单例 client(整个 extension host 共享,多窗口复用)。
- 桥进程:detached spawn、stderr 进输出通道、`exit` 事件后下次自动重起。
- `jcode.executablePath` / `jcode.launchArguments` 配置(默认解析 `~/.local/bin/jcode` → `~/.jcode/builds/current/jcode` → PATH)。

---

## 6. 文件结构

```
jcode-vscode/
├── package.json            # contributes: views(activityBar 侧边栏)/ commands / menus / configuration
├── extension.js            # 主程序:激活、命令、连接管理、会话状态机、编辑器上下文
├── media/
│   ├── chat.html           # webview 骨架(引用 css/js,含 <select id="model"> 等控件)
│   ├── chat.js             # webview 客户端逻辑(独立文件,node --check 可验证)
│   ├── style.css
│   └── jcode.svg
├── test/
│   ├── acceptance/         # exthost 验收(消息协议、会话复用、斜杠命令、附件、取消、重连)【保留并适配】
│   ├── mini-connect/       # 真实 jcode 连接冒烟(真实 exthost)【保留】
│   └── webview-check/      # 真实 webview 全流程(ready→bootstrap→restore→session)【保留】
├── scripts/run-acceptance.js
└── README.md
```

---

## 7. 稳定性与测试(防"连不上"复发)

1. **语法门禁**:CI/本地脚本对 `extension.js` 和 `media/chat.js` 跑 `node --check`;新增单测:把 `getChatHtml()` 生成的 HTML 抽出的 `<script>` 编译一次(直接拦截本次根因)。
2. **真实 exthost 冒烟**(mini-connect):走扩展真实连接路径发一条消息,断言返回 `session_id`。
3. **真实 webview 全流程**(webview-check):focus 视图 → 等 `ready` → 等 `restore` 完成 → 断言 session 建立。
4. **验收套件**(acceptance):保留原 wire-level 断言(消息顺序 `running:true→user→sendAccepted→delta→assistant→running:false`、会话复用、斜杠命令不走模型、重连 reattach、并发拒绝等),按新文件布局微调(如 `<select id="model">` 断言指向 `media/chat.html`)。
5. **手工清单**:首次连接(无桥自动起)、jcode 升级后重连、断网/杀桥恢复、模型切换、新会话、会话切换、取消/软中断、终端 agent、三个选区命令、粘贴图片、长选区超限。

---

## 8. 明确范围外(第一版)

- Windows named-pipe 路径:SDK 已支持但官方标注"未端到端验证",代码保持可移植,macOS/Linux 实测。
- Remote-SSH / Codespaces 内的 jcode 桥:后续版本(桥必须跑在远端)。
- 会话内文件搜索 UI(`readFile/findFiles/searchText` 的命令入口):二期。
- 完整 TUI 替代:不复制终端全部界面;侧边栏做 wrapper 核心交互,`Jcode: Open Terminal Agent` 打开完整 TUI 兜底。

---

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 骨架 | package.json + 侧边栏 webview(外部资源)+ 连接状态机 | webview-check PASS;mini-connect PASS |
| M2 聊天 | 流式聊天、推理/工具/用量展示、取消、模型/努力度、附件 | acceptance PASS(消息协议) |
| M3 上下文 | 选择桥(Explain/Fix/Ask)+ 编辑器状态注入 + workingDir 对齐 | acceptance 选区用例 PASS |
| M4 会话管理 | 会话切换器、新建/重命名/归档、历史恢复、斜杠命令全集 | acceptance 会话用例 PASS |
| M5 打磨 | 权限 UI(按 capability 探测)、状态栏、diagnose、README | 手工清单全过 |
