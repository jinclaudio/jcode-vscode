#!/usr/bin/env python3
"""Fake `jcode acp` adapter for acceptance testing.

Speaks Agent Client Protocol v1 over stdio (JSON-RPC 2.0, newline-delimited).
It logs *normalized* request frames (using the old SDK-style field names) to
$FAKE_BRIDGE_LOG and writes session state under $JCODE_HOME/sessions so the
extension's disk-based session list/history work. When invoked without the
`acp` subcommand (the terminal-agent path) it just records its arguments.
"""
import json
import os
import sys

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None

ARGS_LOG = os.environ.get("FAKE_ARGS_LOG", "")
BRIDGE_LOG = os.environ.get("FAKE_BRIDGE_LOG", "")
JCODE_HOME = os.environ.get("JCODE_HOME", os.path.expanduser("~/.jcode"))
SESSION_DIR = os.path.join(JCODE_HOME, "sessions")

MODELS = ["test-model-a", "test-model-b", "gpt-5.5", "claude-opus-4-6"]

state = {"sessions": {}, "current": "test-model-a", "effort": "low", "tick": 0}
# session id -> pending session/prompt request id (held until session/cancel)
pending = {}


def next_session_number():
    """Atomically allocate a unique session number across concurrent adapter
    processes (the task manager runs several `jcode acp` processes at once)."""
    os.makedirs(SESSION_DIR, exist_ok=True)
    counter_path = os.path.join(SESSION_DIR, ".counter")
    if fcntl is None:
        try:
            with open(counter_path) as f:
                n = int(f.read().strip())
        except (OSError, ValueError):
            n = 0
        n += 1
        with open(counter_path, "w") as f:
            f.write(str(n))
        return n
    lock_path = os.path.join(SESSION_DIR, ".counter.lock")
    with open(lock_path, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            try:
                with open(counter_path) as f:
                    n = int(f.read().strip())
            except (OSError, ValueError):
                n = 0
            n += 1
            with open(counter_path, "w") as f:
                f.write(str(n))
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    return n


def log_args():
    if ARGS_LOG:
        with open(ARGS_LOG, "a") as f:
            f.write("\0".join(sys.argv[1:]) + "\n")


def log_frame(frame):
    if BRIDGE_LOG:
        with open(BRIDGE_LOG, "a") as f:
            f.write(json.dumps(frame) + "\n")


def write_msg(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def config_options():
    return [
        {"id": "model", "name": "Model", "category": "model", "type": "select",
         "currentValue": state["current"],
         "options": [{"value": m, "name": m} for m in MODELS]},
        {"id": "reasoning_effort", "name": "Reasoning effort", "category": "thought_level",
         "type": "select", "currentValue": state["effort"],
         "options": [{"value": e, "name": e} for e in ["none", "low", "medium", "high", "max"]]},
    ]


def models_obj():
    return {"availableModels": [{"modelId": m, "name": m} for m in MODELS],
            "currentModelId": state["current"]}


def persist(sid):
    os.makedirs(SESSION_DIR, exist_ok=True)
    meta = {
        "id": sid,
        "title": None,
        "working_dir": state["sessions"][sid].get("working_dir"),
        "model": state["current"],
        "provider_key": "test-provider",
        "status": "Active",
        "created_at": "2026-08-22T12:00:00Z",
        "updated_at": state["sessions"][sid].get("updated_at", "2026-08-22T12:00:00Z"),
        "messages": state["sessions"][sid].get("history", []),
    }
    with open(os.path.join(SESSION_DIR, sid + ".json"), "w") as f:
        json.dump(meta, f)


def notify(session_id, update):
    write_msg({"jsonrpc": "2.0", "method": "session/update",
               "params": {"sessionId": session_id, "update": update}})


def extract_prompt(params):
    text = ""
    images = []
    for block in params.get("prompt", []):
        kind = block.get("type")
        if kind == "text":
            text += block.get("text", "")
        elif kind == "image":
            images.append([block.get("mimeType"), block.get("data")])
    return text, images


def handle(request_id, method, params):
    if method == "initialize":
        write_msg({"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": True,
                "promptCapabilities": {"image": True, "audio": False, "embeddedContext": True},
                "mcpCapabilities": {"http": False, "sse": False},
                "sessionCapabilities": {"close": {}, "resume": {}},
            },
            "agentInfo": {"name": "jcode", "title": "Jcode", "version": "0.79.1-fake"},
            "authMethods": [],
        }})
        return
    if method == "session/new":
        sid = "fake-session-%d" % next_session_number()
        state["tick"] += 1
        cwd = params.get("cwd")
        state["sessions"][sid] = {
            "working_dir": cwd, "history": [],
            "updated_at": "2026-08-22T12:%02d:%02dZ" % (state["tick"] // 60, state["tick"] % 60),
        }
        persist(sid)
        log_frame({"req": "create_session", "working_dir": cwd, "id": request_id})
        write_msg({"jsonrpc": "2.0", "id": request_id, "result": {
            "sessionId": sid, "configOptions": config_options(), "models": models_obj()}})
        return
    if method == "session/load":
        sid = params.get("sessionId")
        log_frame({"req": "attach_session", "session_id": sid})
        if sid not in state["sessions"]:
            write_msg({"jsonrpc": "2.0", "id": request_id,
                       "error": {"code": -32000, "message": "no such session"}})
        else:
            write_msg({"jsonrpc": "2.0", "id": request_id,
                       "result": {"configOptions": config_options()}})
        return
    if method == "session/resume":
        log_frame({"req": "attach_session", "session_id": params.get("sessionId")})
        write_msg({"jsonrpc": "2.0", "id": request_id,
                   "result": {"configOptions": config_options()}})
        return
    if method == "session/close":
        write_msg({"jsonrpc": "2.0", "id": request_id, "result": {}})
        return
    if method == "session/set_config_option":
        sid = params.get("sessionId")
        cid = params.get("configId")
        value = params.get("value")
        if cid == "model":
            log_frame({"req": "set_model", "session_id": sid, "model": value})
            if value == "bad-model":
                write_msg({"jsonrpc": "2.0", "id": request_id,
                           "error": {"code": -32000, "message": "unknown model"}})
                return
            state["current"] = value
        elif cid == "reasoning_effort":
            log_frame({"req": "set_reasoning_effort", "session_id": sid, "effort": value})
            state["effort"] = value
        write_msg({"jsonrpc": "2.0", "id": request_id, "result": {"configOptions": config_options()}})
        return
    if method == "session/cancel":
        sid = params.get("sessionId")
        log_frame({"req": "cancel", "session_id": sid})
        if sid in pending:
            rid = pending.pop(sid)
            write_msg({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "cancelled"}})
        return
    if method == "session/prompt":
        sid = params.get("sessionId")
        text, images = extract_prompt(params)
        log_frame({"req": "send_message", "session_id": sid, "content": text, "images": images})
        sess = state["sessions"].setdefault(sid, {"working_dir": params.get("cwd"), "history": []})
        sess.setdefault("history", []).append({"role": "user", "content": text})
        if "WAIT_FOR_CANCEL" in text:
            pending[sid] = request_id
            persist(sid)
            return  # hold the turn until session/cancel
        if "SHOW_METRICS" in text:
            todo_input = {"todos": [
                {"id": "live", "content": "Implement live dashboard", "status": "in_progress",
                 "priority": "high", "group": "metrics", "confidence": "plausible"},
                {"id": "tested", "content": "Validate metric calculations", "status": "completed",
                 "priority": "low", "group": "metrics", "confidence": "validated",
                 "completion_confidence": "verified"},
            ]}
            notify(sid, {"sessionUpdate": "tool_call", "toolCallId": "todo-1",
                         "title": "todo", "kind": "other", "status": "pending"})
            notify(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "todo-1",
                         "status": "in_progress", "title": "todo", "rawInput": todo_input})
            notify(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "todo-1",
                         "status": "completed", "title": "todo", "rawInput": todo_input,
                         "rawOutput": {"output": "ok"}})
        resp_text = "FAKE_CHAT_RESPONSE: " + text[:80]
        sess["history"].append({"role": "assistant", "content": resp_text})
        state["tick"] += 1
        sess["updated_at"] = "2026-08-22T12:%02d:%02dZ" % (state["tick"] // 60, state["tick"] % 60)
        persist(sid)
        notify(sid, {"sessionUpdate": "agent_message_chunk",
                     "content": {"type": "text", "text": resp_text}})
        write_msg({"jsonrpc": "2.0", "id": request_id, "result": {
            "stopReason": "end_turn",
            "usage": {"inputTokens": 250, "outputTokens": 100,
                      "cachedReadTokens": 750, "totalTokens": 1100}}})
        return
    write_msg({"jsonrpc": "2.0", "id": request_id,
               "error": {"code": -32601, "message": "Unsupported ACP method: " + method}})


def load_sessions():
    """Reload session state from disk so a fresh adapter process can still
    attach to sessions created by a previous one (matching real jcode, which
    persists sessions under ~/.jcode/sessions)."""
    if not os.path.isdir(SESSION_DIR):
        return
    for name in os.listdir(SESSION_DIR):
        if not name.endswith(".json"):
            continue
        sid = name[:-5]
        try:
            with open(os.path.join(SESSION_DIR, name)) as f:
                meta = json.load(f)
            state["sessions"][sid] = {
                "working_dir": meta.get("working_dir"),
                "history": meta.get("messages", []),
                "updated_at": meta.get("updated_at", "2026-08-22T12:00:00Z"),
            }
        except (OSError, ValueError):
            pass


def main():
    args = sys.argv[1:]
    if "acp" not in args:
        log_args()
        for _ in sys.stdin:
            pass
        sys.exit(0)
    load_sessions()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except json.JSONDecodeError:
            continue
        if frame.get("method"):
            rid = frame.get("id")
            if rid is not None:
                handle(rid, frame["method"], frame.get("params", {}))
            else:
                handle(None, frame["method"], frame.get("params", {}))
        # Responses from the client (permission answers) are ignored here.


if __name__ == "__main__":
    main()
