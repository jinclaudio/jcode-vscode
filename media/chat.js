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
  var modelInput = document.getElementById("model");
  var effortSelect = document.getElementById("effort");
  var sessionStatus = document.getElementById("session-status");

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

  function persist() {
    var items = Array.prototype.map.call(messages.querySelectorAll(".chat[data-role]"), function (item) {
      return {
        role: item.dataset.role,
        text: item.querySelector(".chat-bubble").textContent,
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
    bubble.textContent = text;
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

  function populateModelOptions(models, selected) {
    var names = Array.from(new Set((models || []).filter(Boolean)));
    modelInput.replaceChildren();
    var auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Model: auto";
    modelInput.append(auto);
    if (selected && !names.includes(selected)) {
      names.unshift(selected);
    }
    names.forEach(function (name) {
      var option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      modelInput.append(option);
    });
    modelInput.value = selected || "";
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
    populateModelOptions(data.models || [], data.model !== undefined ? data.model : modelInput.value);
    populateEffortOptions(data.effortLevels || []);
    if (data.effort !== undefined) {
      effortSelect.value = data.effort;
    }
  }

  function setRunning(running, turnId) {
    document.body.classList.toggle("running", running);
    prompt.disabled = running;
    modelInput.disabled = running;
    effortSelect.disabled = running;
    document.getElementById("attach").disabled = running;
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
    sessionStatus.textContent = running ? "Working…" : "Ready";
    sessionStatus.classList.remove("error");
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
    if (!text || submitting || document.body.classList.contains("running")) {
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
      model: modelInput.value.trim(),
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
  modelInput.addEventListener("change", function () {
    vscode.postMessage({ type: "model", model: modelInput.value.trim() });
  });
  effortSelect.addEventListener("change", function () {
    vscode.postMessage({ type: "effort", effort: effortSelect.value });
  });
  window.addEventListener("keydown", function (event) {
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
          populateModelOptions(Array.prototype.map.call(modelInput.options, function (option) {
            return option.value;
          }), data.model);
        }
        if (data.effort !== undefined) {
          effortSelect.value = data.effort;
        }
        break;
      case "user":
        if (data.turnId !== undefined) {
          activeTurnId = data.turnId;
        }
        appendMessage("user", data.text, data.selection || "", data.attachments || []);
        setSelection("");
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
        liveBubble.bubble.textContent += data.text;
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
          liveBubble.bubble.textContent = data.text;
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
      case "openModelPicker":
        modelInput.focus();
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

  vscode.postMessage({ type: "ready", hasHistory: Boolean((saved.messages || []).length) });
})();
