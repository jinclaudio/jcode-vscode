/* jcode VS Code sidebar chat - webview client */
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();
  window.addEventListener("error", function (event) {
    try {
      vscode.postMessage({ type: "webviewError", message: String(event.message || event.error || "unknown webview error") });
    } catch (error) {
      // The API object may not be available yet; nothing more to do.
    }
  });

  var messages = document.getElementById("messages");
  var empty = document.getElementById("empty");
  var prompt = document.getElementById("prompt");
  var selection = document.getElementById("selection");
  var selectionLabel = document.getElementById("selection-label");
  var selectionToggle = document.getElementById("selection-toggle");
  var attachmentList = document.getElementById("attachments");
  var slashMenu = document.getElementById("slash-menu");
  var modelButton = document.getElementById("model");
  var modelLabel = document.getElementById("model-label");
  var effortSelect = document.getElementById("effort");
  var sessionStatus = document.getElementById("session-status");
  var runtimePopover = document.getElementById("runtime-popover");
  var runtimeTitle = document.getElementById("runtime-title");
  var runtimeIndicators = document.getElementById("runtime-indicators");
  var todoIndicator = document.getElementById("todo-indicator");
  var confidenceIndicator = document.getElementById("confidence-indicator");
  var cacheIndicator = document.getElementById("cache-indicator");
  var contextIndicator = document.getElementById("context-indicator");
  var todoCount = document.getElementById("todo-count");
  var todoSummary = document.getElementById("todo-summary");
  var todoList = document.getElementById("todo-list");
  var taskPanel = document.getElementById("task-panel");
  var taskForm = document.getElementById("task-form");
  var taskList = document.getElementById("task-list");
  var tasks = [];
  var maxConcurrent = 3;
  var taskDefaultMode = "worktree";
  var taskDefaultAutoCommit = true;

  var saved = vscode.getState() || { messages: [] };
  var liveBubble;
  var attachments = [];
  var slashCommands = [];
  var slashMatches = [];
  var slashIndex = 0;
  var includeSelection = true;
  var submitting = false;
  var pendingDraft = "";
  var activeTurnId;
  var closedTurnIds = new Set();
  var pendingPastes = 0;
  var selectedModel = "";
  var availableModels = [];

  if (window.marked && typeof window.marked.setOptions === "function") {
    window.marked.setOptions({ gfm: true, breaks: true });
  }

  function renderMarkdown(element, text) {
    var source = String(text || "");
    if (!window.marked || !window.DOMPurify) {
      element.textContent = source;
      return;
    }
    try {
      var rendered = window.marked.parse(source, { gfm: true, breaks: true });
      element.innerHTML = window.DOMPurify.sanitize(rendered, {
        FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "img"],
        FORBID_ATTR: ["style", "srcdoc"],
      });
      element.querySelectorAll("a[href]").forEach(function (link) {
        link.setAttribute("rel", "noopener noreferrer");
        link.setAttribute("target", "_blank");
      });
    } catch (error) {
      element.textContent = source;
    }
  }

  function persist() {
    var items = Array.prototype.map.call(messages.querySelectorAll(".chat[data-role]"), function (item) {
      return {
        role: item.dataset.role,
        text: item.__rawText != null ? item.__rawText : item.querySelector(".chat-bubble").textContent,
        meta: item.querySelector(".chat-footer") ? item.querySelector(".chat-footer").textContent : "",
        attachments: JSON.parse(item.dataset.attachments || "[]"),
      };
    });
    vscode.setState({ messages: items });
  }

  function attachmentIcon(kind) {
    return kind === "image" ? "▧" : "▤";
  }

  function createMessageAttachments(items) {
    if (!items || !items.length) {
      return undefined;
    }
    var wrap = document.createElement("div");
    wrap.className = "message-attachments";
    items.forEach(function (file) {
      if (file.kind === "image" && file.dataUri) {
        var image = document.createElement("img");
        image.className = "message-image";
        image.src = file.dataUri;
        image.alt = file.name || "attached image";
        wrap.append(image);
        return;
      }
      var chip = document.createElement("div");
      chip.className = "message-file";
      var kind = document.createElement("b");
      kind.textContent = attachmentIcon(file.kind);
      var name = document.createElement("span");
      name.textContent = file.name;
      chip.append(kind, name);
      wrap.append(chip);
    });
    return wrap;
  }

  function appendMessage(role, text, meta, files) {
    empty.hidden = true;
    var item = document.createElement("article");
    item.className = "chat " + (role === "user" ? "chat-user" : "chat-assistant");
    item.dataset.role = role;
    item.dataset.attachments = JSON.stringify(files || []);
    item.__rawText = String(text || "");
    var header = document.createElement("div");
    header.className = "chat-header";
    var avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "Y" : "J";
    var label = document.createElement("span");
    label.textContent = role === "user" ? "You" : "Jcode";
    header.append(avatar, label);
    var bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    renderMarkdown(bubble, item.__rawText);
    item.append(header);
    var fileWrap = createMessageAttachments(files);
    if (fileWrap) {
      item.append(fileWrap);
    }
    item.append(bubble);
    if (meta) {
      var footer = document.createElement("div");
      footer.className = "chat-footer";
      footer.textContent = meta;
      item.append(footer);
    }
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
    persist();
    return item;
  }

  function createLiveBubble() {
    empty.hidden = true;
    var typing = document.getElementById("typing");
    if (typing) {
      typing.remove();
    }
    var item = document.createElement("article");
    item.className = "chat chat-assistant";
    item.dataset.role = "assistant";
    item.dataset.attachments = "[]";
    item.__rawText = "";
    var header = document.createElement("div");
    header.className = "chat-header";
    header.innerHTML = '<span class="avatar">J</span><span>Jcode</span>';
    var bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    var footer = document.createElement("div");
    footer.className = "chat-footer";
    item.append(header, bubble, footer);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
    return { item: item, bubble: bubble, footer: footer };
  }

  function finalizeLiveBubble(meta) {
    if (!liveBubble) {
      return;
    }
    liveBubble.footer.textContent = meta || "";
    liveBubble = undefined;
    persist();
  }

  function appendNotice(text, isError) {
    empty.hidden = true;
    var notice = document.createElement("div");
    notice.className = "notice" + (isError ? " error" : "");
    notice.textContent = text;
    messages.append(notice);
    messages.scrollTop = messages.scrollHeight;
  }

  function appendCommandCard(title, rows) {
    empty.hidden = true;
    var card = document.createElement("section");
    card.className = "command-card";
    var heading = document.createElement("div");
    heading.className = "command-title";
    heading.textContent = title;
    card.append(heading);
    (rows || []).forEach(function (row) {
      var line = document.createElement("div");
      line.className = "command-row";
      var key = document.createElement("code");
      key.textContent = row[0];
      var value = document.createElement("span");
      value.textContent = row[1];
      line.append(key, value);
      card.append(line);
    });
    messages.append(card);
    messages.scrollTop = messages.scrollHeight;
  }

  function appendReasoning(text, turnId) {
    if (!text) {
      return;
    }
    var bubble = document.querySelector(".chat-assistant[data-turn='" + turnId + "'] .chat-bubble");
    var existing = document.querySelector(".chat-assistant[data-turn='" + turnId + "'] .reasoning");
    var body;
    if (!existing) {
      var details = document.createElement("details");
      details.className = "reasoning";
      details.open = false;
      var summary = document.createElement("summary");
      summary.textContent = "Thinking";
      body = document.createElement("div");
      body.className = "reasoning-body";
      details.append(summary, body);
      var target = bubble ? bubble.parentElement : messages.lastElementChild;
      if (target && target.classList.contains("chat-assistant")) {
        target.append(details);
      }
      existing = details;
    }
    body = existing.querySelector(".reasoning-body");
    body.textContent = text;
    messages.scrollTop = messages.scrollHeight;
  }

  function appendToolCall(name, detail, isError, turnId) {
    var item = document.createElement("details");
    item.className = "tool-call";
    item.open = false;
    var summary = document.createElement("summary");
    summary.innerHTML = "";
    var label = document.createElement("span");
    label.textContent = "Tool";
    var toolName = document.createElement("code");
    toolName.className = "tool-name";
    toolName.textContent = name || "";
    summary.append(label, " ", toolName);
    var body = document.createElement("div");
    body.className = "tool-body" + (isError ? " error" : "");
    body.textContent = detail || "";
    item.append(summary, body);
    var target = messages.lastElementChild;
    if (target && target.classList.contains("chat-assistant")) {
      target.append(item);
    } else {
      messages.append(item);
    }
    messages.scrollTop = messages.scrollHeight;
  }

  function setSelection(label) {
    selectionLabel.textContent = label || "";
    selection.title = label || "";
    selection.classList.toggle("visible", Boolean(label) && includeSelection);
  }

  function formatBytes(size) {
    if (!size) {
      return "";
    }
    if (size < 1024) {
      return size + " B";
    }
    if (size < 1024 * 1024) {
      return Math.round(size / 1024) + " KB";
    }
    return (size / (1024 * 1024)).toFixed(1) + " MB";
  }

  function renderAttachments(items) {
    attachments = items || [];
    attachmentList.replaceChildren();
    attachments.forEach(function (file) {
      var chip = document.createElement("div");
      chip.className = "attachment-chip";
      chip.title = file.name + (file.size ? " · " + formatBytes(file.size) : "");
      var kind = document.createElement("span");
      kind.className = "attachment-kind";
      kind.textContent = attachmentIcon(file.kind);
      var name = document.createElement("span");
      name.className = "attachment-name";
      name.textContent = file.name;
      var remove = document.createElement("button");
      remove.className = "attachment-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Remove attachment";
      remove.setAttribute("aria-label", "Remove " + file.name);
      remove.addEventListener("click", function () {
        vscode.postMessage({ type: "removeAttachment", id: file.id });
      });
      chip.append(kind, name, remove);
      attachmentList.append(chip);
    });
    attachmentList.classList.toggle("visible", attachments.length > 0);
  }

  function formatTokens(value) {
    var amount = Math.max(0, Number(value) || 0);
    if (amount >= 1000000) return (amount / 1000000).toFixed(amount >= 10000000 ? 0 : 1) + "M";
    if (amount >= 1000) return (amount / 1000).toFixed(amount >= 100000 ? 0 : 1) + "k";
    return String(Math.round(amount));
  }

  function setMetric(valueId, barId, text, ratio, confidence) {
    var value = document.getElementById(valueId);
    var bar = document.getElementById(barId);
    value.textContent = text;
    bar.style.width = Math.max(0, Math.min(100, (Number(ratio) || 0) * 100)) + "%";
    if (confidence) {
      value.dataset.confidence = confidence;
      bar.dataset.confidence = confidence;
    } else {
      delete value.dataset.confidence;
      delete bar.dataset.confidence;
    }
  }

  function todoConfidence(todo) {
    return todo.status === "completed"
      ? todo.completion_confidence || todo.confidence
      : todo.confidence;
  }

  var runtimePanelTitles = {
    todo: "Todos",
    confidence: "Confidence",
    cache: "KV cache",
    context: "Context",
  };

  function closeRuntimePopover() {
    runtimePopover.hidden = true;
    document.querySelectorAll(".runtime-indicator").forEach(function (indicator) {
      indicator.setAttribute("aria-expanded", "false");
    });
  }

  function showRuntimePanel(panel, button) {
    if (!runtimePopover.hidden && runtimePopover.dataset.panel === panel) {
      closeRuntimePopover();
      return;
    }
    runtimePopover.dataset.panel = panel;
    runtimeTitle.textContent = runtimePanelTitles[panel] || "Agent status";
    runtimePopover.setAttribute("aria-label", (runtimePanelTitles[panel] || "Agent status") + " details");
    runtimePopover.querySelectorAll("[data-runtime-content]").forEach(function (content) {
      content.hidden = content.dataset.runtimeContent !== panel;
    });
    runtimePopover.hidden = false;
    document.querySelectorAll(".runtime-indicator").forEach(function (indicator) {
      indicator.setAttribute("aria-expanded", indicator === button ? "true" : "false");
    });
  }

  function renderRuntimeState(state) {
    state = state || {};
    var todos = Array.isArray(state.todos) ? state.todos : [];
    var hasUsage = Number(state.effectiveInputTokens) > 0 || Number(state.contextTokens) > 0;
    var hasData = todos.length > 0 || hasUsage;
    runtimeIndicators.hidden = !hasData;
    if (!hasData) closeRuntimePopover();

    var completed = todos.filter(function (todo) { return todo.status === "completed"; }).length;
    todoSummary.textContent = todos.length ? completed + "/" + todos.length + " done" : "";
    todoIndicator.hidden = todos.length === 0;
    todoCount.textContent = todos.length ? String(todos.length) : "";
    todoIndicator.title = todos.length ? "Todos: " + completed + "/" + todos.length + " completed" : "Todos";

    var confidence = state.aggregateConfidence || "unknown";
    var confidenceIndex = ["speculative", "plausible", "validated", "verified"].indexOf(confidence);
    setMetric("confidence-value", "confidence-bar", confidence === "unknown" ? "—" : confidence, (confidenceIndex + 1) / 4, confidence);
    confidenceIndicator.hidden = confidence === "unknown";
    confidenceIndicator.dataset.confidence = confidence;
    confidenceIndicator.title = confidence === "unknown" ? "Confidence unavailable" : "Confidence: " + confidence;

    var effectiveInput = Math.max(0, Number(state.effectiveInputTokens) || 0);
    var cacheRead = Math.max(0, Number(state.cacheReadTokens) || 0);
    var cacheRatio = effectiveInput > 0 ? cacheRead / effectiveInput : 0;
    setMetric("cache-value", "cache-bar", effectiveInput > 0 ? Math.round(Math.min(1, cacheRatio) * 100) + "%" : "—", cacheRatio);
    cacheIndicator.hidden = !hasUsage;
    cacheIndicator.dataset.tone = cacheRatio >= 0.7 ? "good" : cacheRatio >= 0.35 ? "warn" : "low";
    cacheIndicator.title = effectiveInput > 0
      ? "KV cache: " + Math.round(Math.min(1, cacheRatio) * 100) + "% (" + formatTokens(cacheRead) + "/" + formatTokens(effectiveInput) + ")"
      : "KV cache unavailable";

    var contextTokens = Math.max(0, Number(state.contextTokens) || 0);
    var contextLimit = Math.max(1, Number(state.contextLimit) || 200000);
    setMetric(
      "context-value",
      "context-bar",
      contextTokens > 0 ? formatTokens(contextTokens) + "/" + formatTokens(contextLimit) : "—",
      contextTokens / contextLimit
    );
    var contextRatio = contextTokens / contextLimit;
    contextIndicator.hidden = !hasUsage;
    contextIndicator.dataset.tone = contextRatio >= 0.8 ? "low" : contextRatio >= 0.5 ? "warn" : "good";
    contextIndicator.title = contextTokens > 0
      ? "Context: " + formatTokens(contextTokens) + "/" + formatTokens(contextLimit) + " (" + Math.round(Math.min(1, contextRatio) * 100) + "%)"
      : "Context unavailable";

    if (!runtimePopover.hidden) {
      var activeIndicator = document.querySelector('.runtime-indicator[data-runtime-panel="' + runtimePopover.dataset.panel + '"]');
      if (!activeIndicator || activeIndicator.hidden) closeRuntimePopover();
    }

    todoList.replaceChildren();
    var previousGroup;
    todos.forEach(function (todo) {
      var group = todo.group || "";
      if (group && group !== previousGroup) {
        var groupLabel = document.createElement("div");
        groupLabel.className = "todo-group";
        groupLabel.textContent = group;
        todoList.append(groupLabel);
      }
      previousGroup = group;
      var row = document.createElement("div");
      row.className = "todo-item todo-" + (todo.status || "pending");
      var status = document.createElement("span");
      status.className = "todo-status";
      status.textContent = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▶" : todo.status === "cancelled" ? "×" : "○";
      var content = document.createElement("span");
      content.className = "todo-content";
      content.textContent = todo.content || todo.id || "Untitled todo";
      var itemConfidence = todoConfidence(todo);
      var badge = document.createElement("span");
      badge.className = "confidence-badge";
      badge.dataset.confidence = itemConfidence || "unknown";
      badge.textContent = itemConfidence || "?";
      row.append(status, content, badge);
      todoList.append(row);
    });
  }

  function applyModelState(models, selected) {
    availableModels = Array.from(new Set((models || availableModels || []).filter(Boolean)));
    selectedModel = selected || "";
    if (selectedModel && !availableModels.includes(selectedModel)) {
      availableModels.unshift(selectedModel);
    }
    modelLabel.textContent = selectedModel || "auto";
    modelButton.title = selectedModel ? "Model: " + selectedModel : "Model: automatic";
    modelButton.setAttribute("aria-label", modelButton.title + ". Select model");
  }

  function populateEffortOptions(levels) {
    effortSelect.replaceChildren();
    var auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "auto";
    effortSelect.append(auto);
    (levels || []).forEach(function (level) {
      var option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      effortSelect.append(option);
    });
  }

  function applyOptions(data) {
    applyModelState(data.models || [], data.model !== undefined ? data.model : selectedModel);
    populateEffortOptions(data.effortLevels || []);
    if (data.effort !== undefined) {
      effortSelect.value = data.effort;
    }
  }

  function setRunning(running, turnId) {
    document.body.classList.toggle("running", running);
    prompt.disabled = false;
    prompt.placeholder = running ? "Steer Jcode while it works…" : "Ask Jcode… Type / for commands";
    modelButton.disabled = running;
    effortSelect.disabled = running;
    document.getElementById("attach").disabled = running;
    document.getElementById("send").title = running ? "Steer current response" : "Send message";
    document.getElementById("send").setAttribute("aria-label", running ? "Steer current response" : "Send message");
    var typing = document.getElementById("typing");
    if (running && !typing) {
      typing = document.createElement("article");
      typing.id = "typing";
      typing.className = "chat chat-assistant";
      typing.innerHTML = '<div class="chat-header"><span class="avatar">J</span><span>Jcode</span></div><div class="typing" aria-label="Jcode is responding"><i></i><i></i><i></i></div>';
      messages.append(typing);
      messages.scrollTop = messages.scrollHeight;
    } else if (!running && typing) {
      typing.remove();
      finalizeLiveBubble();
    }
    sessionStatus.textContent = running ? "Working… steering available" : "Ready";
    sessionStatus.classList.remove("error");
  }

  function taskAction(label, type, taskId) {
    var button = document.createElement("button");
    button.className = "small-btn";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", function () {
      vscode.postMessage({ type: type, taskId: taskId });
    });
    return button;
  }

  function renderTasks(items, concurrent, enabled, defaultIsolation, autoCommit) {
    tasks = Array.isArray(items) ? items : [];
    maxConcurrent = concurrent || maxConcurrent;
    if (["worktree", "shared", "read-only"].includes(defaultIsolation)) taskDefaultMode = defaultIsolation;
    if (typeof autoCommit === "boolean") taskDefaultAutoCommit = autoCommit;
    if (taskForm.hidden) {
      document.getElementById("task-mode").value = taskDefaultMode;
      document.getElementById("task-auto-commit").checked = taskDefaultAutoCommit;
    }
    var taskToggle = document.getElementById("tasks-toggle");
    taskToggle.hidden = enabled === false;
    if (enabled === false) taskPanel.hidden = true;
    taskList.replaceChildren();
    var active = tasks.filter(function (task) { return task.status === "running"; }).length;
    var queued = tasks.filter(function (task) { return task.status === "queued" || task.status === "preparing"; }).length;
    var badge = document.getElementById("task-badge");
    badge.textContent = active ? String(active) : "";
    badge.classList.toggle("visible", active > 0);
    document.getElementById("task-summary").textContent = tasks.length
      ? active + " running · " + queued + " queued · max " + maxConcurrent
      : "No tasks";
    if (!tasks.length) {
      var emptyTask = document.createElement("div");
      emptyTask.className = "task-empty";
      emptyTask.textContent = "Create parallel worker sessions for independent repository tasks.";
      taskList.append(emptyTask);
      return;
    }
    tasks.forEach(function (task) {
      var card = document.createElement("article");
      card.className = "task-card " + task.status;
      card.dataset.taskId = task.id;
      var head = document.createElement("div");
      head.className = "task-card-head";
      var title = document.createElement("div");
      title.className = "task-card-title";
      title.textContent = task.title;
      title.title = task.title;
      var status = document.createElement("span");
      status.className = "task-status";
      status.textContent = task.status;
      head.append(title, status);
      var meta = document.createElement("div");
      meta.className = "task-card-meta";
      meta.textContent = [task.kind, task.mode, task.branch, task.model, task.activity].filter(Boolean).join(" · ");
      var output = document.createElement("div");
      output.className = "task-card-output" + (task.error ? " task-card-error" : "");
      output.textContent = String(task.error || task.summary || task.output || task.prompt || "").slice(-600);
      var actions = document.createElement("div");
      actions.className = "task-card-actions";
      if (task.sessionId && task.status !== "running") actions.append(taskAction("Open", "openTask", task.id));
      if (["running", "queued", "preparing", "detached"].includes(task.status)) {
        actions.append(taskAction("Cancel", "cancelTask", task.id));
      }
      if (task.mode === "worktree") {
        actions.append(taskAction("Diff", "diffTask", task.id));
        actions.append(taskAction("Commit", "commitTask", task.id));
        if (task.status === "completed") actions.append(taskAction("Merge", "mergeTask", task.id));
      }
      if (task.status !== "running" && task.status !== "preparing") {
        actions.append(taskAction("Remove", "removeTask", task.id));
      }
      card.append(head, meta, output, actions);
      taskList.append(card);
    });
  }

  function taskFormValue() {
    return {
      title: document.getElementById("task-title").value.trim(),
      prompt: document.getElementById("task-prompt").value.trim(),
      mode: document.getElementById("task-mode").value,
      kind: document.getElementById("task-kind").value,
      dependsOn: document.getElementById("task-dependencies").value,
      autoCommit: document.getElementById("task-auto-commit").checked,
      model: selectedModel,
      effort: effortSelect.value,
    };
  }

  function resetTaskForm() {
    taskForm.reset();
    document.getElementById("task-mode").value = taskDefaultMode;
    document.getElementById("task-auto-commit").checked = taskDefaultAutoCommit;
    taskForm.hidden = true;
  }

  function resizePrompt() {
    prompt.style.height = "auto";
    prompt.style.height = Math.min(prompt.scrollHeight, 200) + "px";
  }

  function commandQuery() {
    var value = prompt.value.trimStart();
    if (!value.startsWith("/") || value.includes("\n") || /\s/.test(value)) {
      return undefined;
    }
    return value.toLowerCase();
  }

  function renderSlashMenu() {
    var query = commandQuery();
    slashMenu.replaceChildren();
    if (query === undefined) {
      slashMatches = [];
      slashMenu.classList.remove("visible");
      return;
    }
    slashMatches = slashCommands.filter(function (command) {
      return command.name.toLowerCase().startsWith(query) || command.name.toLowerCase().includes(query.slice(1));
    }).slice(0, 9);
    slashIndex = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
    slashMatches.forEach(function (command, index) {
      var item = document.createElement("button");
      item.className = "slash-item" + (index === slashIndex ? " selected" : "");
      item.type = "button";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === slashIndex ? "true" : "false");
      var name = document.createElement("code");
      name.textContent = command.usage || command.name;
      var description = document.createElement("span");
      description.textContent = command.description || "";
      var tier = document.createElement("span");
      tier.className = "tier";
      tier.textContent = command.tier || "";
      item.append(name, description, tier);
      item.addEventListener("mousedown", function (event) {
        event.preventDefault();
        acceptSlash(index);
      });
      slashMenu.append(item);
    });
    slashMenu.classList.toggle("visible", slashMatches.length > 0);
  }

  function acceptSlash(index) {
    var command = slashMatches[index];
    if (!command) {
      return false;
    }
    var current = prompt.value.trim();
    if (current === command.name && !command.usage) {
      return false;
    }
    prompt.value = command.name + (command.usage ? " " : "");
    prompt.focus();
    slashIndex = 0;
    resizePrompt();
    renderSlashMenu();
    return true;
  }

  function send() {
    var text = prompt.value.trim();
    if (!text || submitting) {
      return;
    }
    if (pendingPastes > 0) {
      appendNotice("Wait for the pasted image to finish attaching.", false);
      return;
    }
    submitting = true;
    pendingDraft = prompt.value;
    document.getElementById("send").disabled = true;
    vscode.postMessage({
      type: "send",
      text: text,
      includeSelection: includeSelection,
      model: selectedModel,
      effort: effortSelect.value,
      attachmentIds: attachments.map(function (file) {
        return file.id;
      }),
    });
    prompt.value = "";
    slashMenu.classList.remove("visible");
    resizePrompt();
  }

  (saved.messages || []).forEach(function (item) {
    appendMessage(item.role, item.text, item.meta, item.attachments);
  });
  empty.hidden = Boolean((saved.messages || []).length);

  document.querySelectorAll(".starter").forEach(function (button) {
    button.addEventListener("click", function () {
      prompt.value = button.dataset.prompt || "";
      resizePrompt();
      prompt.focus();
    });
  });
  prompt.addEventListener("input", function () {
    resizePrompt();
    slashIndex = 0;
    renderSlashMenu();
  });
  prompt.addEventListener("keydown", function (event) {
    if (slashMenu.classList.contains("visible") && slashMatches.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        slashIndex = (slashIndex + 1) % slashMatches.length;
        renderSlashMenu();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
        renderSlashMenu();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        acceptSlash(slashIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        slashMenu.classList.remove("visible");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        var exact = slashMatches.find(function (command) {
          return command.name === prompt.value.trim();
        });
        if (!exact && acceptSlash(slashIndex)) {
          event.preventDefault();
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  prompt.addEventListener("paste", function (event) {
    var files = Array.prototype.filter.call(event.clipboardData ? event.clipboardData.files || [] : [], function (file) {
      return file.type.startsWith("image/");
    });
    files.forEach(function (file) {
      pendingPastes += 1;
      var reader = new FileReader();
      reader.addEventListener("load", function () {
        var result = String(reader.result || "");
        vscode.postMessage({
          type: "addPastedImage",
          name: file.name || "Pasted image",
          mediaType: file.type,
          data: result.split(",")[1] || "",
        });
        pendingPastes -= 1;
      });
      reader.addEventListener("error", function () {
        pendingPastes -= 1;
        appendNotice("Could not read the pasted image.", true);
      });
      reader.readAsDataURL(file);
    });
  });

  document.getElementById("send").addEventListener("click", send);
  document.getElementById("cancel").addEventListener("click", function () {
    vscode.postMessage({ type: "cancel" });
  });
  document.getElementById("new-chat").addEventListener("click", function () {
    vscode.postMessage({ type: "newChat" });
  });
  document.getElementById("terminal").addEventListener("click", function () {
    vscode.postMessage({ type: "openTerminal" });
  });
  document.getElementById("attach").addEventListener("click", function () {
    vscode.postMessage({ type: "chooseAttachments" });
  });
  selectionToggle.addEventListener("click", function () {
    includeSelection = !includeSelection;
    selectionToggle.classList.toggle("active", includeSelection);
    selectionToggle.setAttribute("aria-pressed", includeSelection ? "true" : "false");
    selection.classList.toggle("visible", includeSelection && Boolean(selectionLabel.textContent));
  });
  modelButton.addEventListener("click", function () {
    vscode.postMessage({ type: "chooseModel" });
  });
  Array.prototype.forEach.call(document.querySelectorAll(".runtime-indicator"), function (button) {
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      showRuntimePanel(button.dataset.runtimePanel, button);
    });
  });
  document.addEventListener("click", function (event) {
    if (!runtimePopover.hidden && !runtimePopover.contains(event.target) && !runtimeIndicators.contains(event.target)) {
      closeRuntimePopover();
    }
  });
  effortSelect.addEventListener("change", function () {
    vscode.postMessage({ type: "effort", effort: effortSelect.value });
  });
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !runtimePopover.hidden) {
      event.preventDefault();
      closeRuntimePopover();
      return;
    }
    if (event.key === "Escape" && document.body.classList.contains("running")) {
      event.preventDefault();
      vscode.postMessage({ type: "cancel" });
    }
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    switch (data.type) {
      case "restore":
        setSelection(data.selection);
        applyOptions(data);
        renderRuntimeState(data.runtimeState);
        slashCommands = data.slashCommands || [];
        renderAttachments(data.attachments || []);
        sessionStatus.textContent = data.error ? "Disconnected" : "Ready";
        sessionStatus.classList.toggle("error", Boolean(data.error));
        if (data.error) {
          appendNotice(data.error, true);
        }
        break;
      case "bootstrap":
        setSelection(data.selection);
        applyOptions(data);
        renderRuntimeState(data.runtimeState);
        slashCommands = data.slashCommands || [];
        renderAttachments(data.attachments || []);
        sessionStatus.textContent = "Connecting…";
        break;
      case "selection":
        setSelection(data.selection);
        if (data.focusComposer) {
          prompt.focus();
        }
        break;
      case "attachments":
        renderAttachments(data.attachments);
        break;
      case "options":
        if (data.model !== undefined) {
          applyModelState(availableModels, data.model);
        }
        if (data.effort !== undefined) {
          effortSelect.value = data.effort;
        }
        break;
      case "runtimeState":
        renderRuntimeState(data.state);
        break;
      case "user":
        if (data.turnId !== undefined) {
          activeTurnId = data.turnId;
        }
        appendMessage("user", data.text, data.selection || "", data.attachments || []);
        setSelection("");
        break;
      case "steering":
        appendMessage("user", data.text, "Steering", []);
        break;
      case "sendAccepted":
      case "sendHandled":
        submitting = false;
        pendingDraft = "";
        document.getElementById("send").disabled = false;
        break;
      case "sendRejected":
        submitting = false;
        if (!prompt.value && pendingDraft) {
          prompt.value = pendingDraft;
        }
        pendingDraft = "";
        document.getElementById("send").disabled = false;
        resizePrompt();
        break;
      case "delta":
        if (data.turnId !== undefined && (closedTurnIds.has(data.turnId) || (activeTurnId !== undefined && data.turnId !== activeTurnId))) {
          break;
        }
        if (!liveBubble) {
          liveBubble = createLiveBubble();
          liveBubble.item.dataset.turn = String(data.turnId || "");
        }
        liveBubble.item.__rawText += data.text;
        renderMarkdown(liveBubble.bubble, liveBubble.item.__rawText);
        messages.scrollTop = messages.scrollHeight;
        break;
      case "reasoning":
        if (data.turnId !== undefined && (closedTurnIds.has(data.turnId) || (activeTurnId !== undefined && data.turnId !== activeTurnId))) {
          break;
        }
        appendReasoning(data.text, data.turnId);
        break;
      case "tool":
        if (data.kind === "start") {
          appendToolCall(data.name, data.detail || "Running…", false, data.turnId);
        } else if (data.kind === "done") {
          appendToolCall(data.name, data.detail || "", Boolean(data.error), data.turnId);
        }
        break;
      case "usage":
        if (data.usage) {
          var parts = [];
          if (data.usage.input) {
            parts.push(String(data.usage.input) + " in");
          }
          if (data.usage.output) {
            parts.push(String(data.usage.output) + " out");
          }
          if (data.usage.cacheReadInput) {
            parts.push(String(data.usage.cacheReadInput) + " cached");
          }
          if (parts.length && liveBubble) {
            liveBubble.footer.textContent = parts.join(" · ");
          }
        }
        break;
      case "assistant":
        if (data.turnId !== undefined && (closedTurnIds.has(data.turnId) || (activeTurnId !== undefined && data.turnId !== activeTurnId))) {
          break;
        }
        if (liveBubble) {
          liveBubble.item.__rawText = String(data.text || "");
          renderMarkdown(liveBubble.bubble, liveBubble.item.__rawText);
          liveBubble.footer.textContent = [data.provider, data.model].filter(Boolean).join(" · ");
          liveBubble = undefined;
          persist();
        } else {
          appendMessage("assistant", data.text, [data.provider, data.model].filter(Boolean).join(" · "), []);
        }
        break;
      case "notice":
        appendNotice(data.text, false);
        break;
      case "error":
        appendNotice(data.text, true);
        break;
      case "running":
        if (data.running) {
          activeTurnId = data.turnId;
        } else if (data.turnId !== undefined && data.turnId !== activeTurnId) {
          break;
        }
        if (!data.running) {
          if (data.turnId !== undefined) {
            closedTurnIds.add(data.turnId);
          }
          activeTurnId = undefined;
        }
        setRunning(data.running, data.turnId);
        break;
      case "commandHelp":
        appendCommandCard("Jcode commands", (data.commands || []).map(function (command) {
          return [command.usage || command.name, command.description];
        }));
        break;
      case "commandInfo":
        appendCommandCard(data.title || "Info", data.rows || []);
        break;
      case "sessions":
        renderSessionList(data.sessions || [], data.currentSessionId);
        break;
      case "tasks":
        renderTasks(data.tasks || [], data.maxConcurrent, data.enabled, data.defaultIsolation, data.autoCommit);
        break;
      case "taskError":
        appendNotice(data.text || "Task operation failed.", true);
        break;
      case "openEffortPicker":
        effortSelect.focus();
        break;
      case "cleared":
        activeTurnId = undefined;
        closedTurnIds.clear();
        submitting = false;
        pendingDraft = "";
        document.getElementById("send").disabled = false;
        liveBubble = undefined;
        messages.querySelectorAll(":scope > :not(#empty)").forEach(function (node) {
          node.remove();
        });
        empty.hidden = false;
        setSelection("");
        renderAttachments([]);
        vscode.setState({ messages: [] });
        prompt.focus();
        break;
    }
  });

  function renderSessionList(sessions, currentSessionId) {
    var existing = document.getElementById("session-picker");
    if (existing) {
      existing.remove();
    }
    var container = document.createElement("div");
    container.id = "session-picker";
    container.className = "session-list";
    var title = document.createElement("div");
    title.className = "command-title";
    title.textContent = "Sessions";
    container.append(title);
    (sessions || []).forEach(function (session) {
      var item = document.createElement("button");
      item.className = "session-item" + (session.session_id === currentSessionId ? " active" : "");
      item.type = "button";
      var main = document.createElement("div");
      main.className = "session-main";
      var name = document.createElement("div");
      name.className = "session-title";
      name.textContent = session.title || session.session_id;
      var meta = document.createElement("div");
      meta.className = "session-meta";
      meta.textContent = [session.working_dir || "", session.status || ""].filter(Boolean).join(" · ");
      main.append(name, meta);
      var actions = document.createElement("div");
      actions.className = "session-actions";
      if (session.session_id !== currentSessionId) {
        var open = document.createElement("button");
        open.className = "icon-btn";
        open.title = "Attach to this session";
        open.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
        open.addEventListener("click", function (event) {
          event.stopPropagation();
          vscode.postMessage({ type: "attachSession", sessionId: session.session_id });
        });
        actions.append(open);
      }
      var rename = document.createElement("button");
      rename.className = "icon-btn";
      rename.title = "Rename";
      rename.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      rename.addEventListener("click", function (event) {
        event.stopPropagation();
        var name = window.prompt("New session title", session.title || "");
        if (name !== null) {
          vscode.postMessage({ type: "renameSession", sessionId: session.session_id, title: name });
        }
      });
      actions.append(rename);
      item.append(main, actions);
      container.append(item);
    });
    messages.append(container);
    messages.scrollTop = messages.scrollHeight;
  }

  document.getElementById("tasks-toggle").addEventListener("click", function () {
    taskPanel.hidden = !taskPanel.hidden;
  });
  document.getElementById("new-task").addEventListener("click", function () {
    taskForm.hidden = !taskForm.hidden;
    if (!taskForm.hidden) document.getElementById("task-title").focus();
  });
  document.getElementById("task-form-cancel").addEventListener("click", resetTaskForm);
  taskForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var task = taskFormValue();
    if (!task.title || !task.prompt) {
      appendNotice("Task title and prompt are required.", true);
      return;
    }
    vscode.postMessage({ type: "createTask", task: task });
    resetTaskForm();
  });
  document.getElementById("task-batch-create").addEventListener("click", function () {
    var mode = document.getElementById("task-mode").value;
    var autoCommit = document.getElementById("task-auto-commit").checked;
    var items = document.getElementById("task-batch").value.split("\n").map(function (line) {
      var parts = line.split("::");
      var title = (parts.shift() || "").trim();
      var taskPrompt = parts.join("::").trim();
      return title && taskPrompt ? { title: title, prompt: taskPrompt, mode: mode, autoCommit: autoCommit, model: selectedModel, effort: effortSelect.value } : undefined;
    }).filter(Boolean);
    if (!items.length) {
      appendNotice("Use one batch task per line: Title :: prompt", true);
      return;
    }
    vscode.postMessage({ type: "createTaskBatch", tasks: items });
    resetTaskForm();
  });

  vscode.postMessage({ type: "ready", hasHistory: Boolean((saved.messages || []).length) });
})();
