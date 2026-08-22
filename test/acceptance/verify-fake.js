// Verify the fake ACP bridge end-to-end through the real AcpClient.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AcpClient } = require("../../acp-client");

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-fake-acp-"));
  process.env.JCODE_HOME = home;
  const bridgeLog = path.join(home, "bridge.log");
  process.env.FAKE_BRIDGE_LOG = bridgeLog;

  const client = await AcpClient.connect({
    executable: "python",
    args: [path.join(__dirname, "fake-acp-bridge.py")],
    clientName: "jcode-vscode/test",
    log: (line) => console.error("LOG:", line),
  });
  console.log("agentInfo:", JSON.stringify(client.agentInfo));

  const { session_id } = await client.createSession("/tmp/proj");
  console.log("created:", session_id);
  if (session_id !== "fake-session-1") throw new Error("expected fake-session-1, got " + session_id);

  const models = await client.listModels(session_id);
  console.log("models:", models.models.length, "current:", models.current);

  await client.setModel(session_id, "gpt-5.5");
  console.log("runtime model after set:", (await client.getRuntimeInfo(session_id)).model);

  const events = [];
  const result = await client.run(session_id, "SHOW_METRICS", {
    onEvent: (event) => {
      if (event.ev === "tool_input_delta") events.push(["tool_input_delta", event.delta]);
      else if (event.ev === "tool_start" || event.ev === "tool_done") events.push([event.ev, event.name]);
      else if (event.ev === "token_usage") events.push(["token_usage", event.input, event.cache_read_input]);
    },
  });
  console.log("run text:", JSON.stringify(result.text));
  console.log("events:", JSON.stringify(events));

  const sessions = await client.listSessions();
  console.log("listSessions:", JSON.stringify(sessions.map((s) => s.session_id)));

  const frames = fs.readFileSync(bridgeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log("bridge frames:", JSON.stringify(frames));

  // Reconnect: a fresh adapter process must still load the existing session.
  await client.close();
  const client2 = await AcpClient.connect({
    executable: "python",
    args: [path.join(__dirname, "fake-acp-bridge.py")],
    clientName: "jcode-vscode/test",
    log: () => {},
  });
  await client2.attachSession(session_id);
  const history = await client2.getHistory(session_id);
  console.log("reconnected history length:", history.length);
  await client2.close();

  fs.rmSync(home, { recursive: true, force: true });
  console.log("FAKE BRIDGE OK");
  process.exit(0);
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
