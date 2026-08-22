// Smoke test the AcpClient against the real `jcode acp` adapter.
const { AcpClient } = require("../acp-client");

async function main() {
  const client = await AcpClient.connect({
    executable: "jcode",
    clientName: "jcode-vscode/smoke",
    log: (line) => console.error("LOG:", line),
  });
  console.log("agentInfo:", JSON.stringify(client.agentInfo));

  const { session_id } = await client.createSession(process.cwd());
  console.log("created session:", session_id);

  const models = await client.listModels(session_id);
  console.log("models count:", models.models.length, "current:", models.current);

  await client.setModel(session_id, "deepseek-v4-pro");
  const runtime = await client.getRuntimeInfo(session_id);
  console.log("runtime model after set:", runtime.model);

  const events = [];
  const result = await client.run(session_id, "Reply with exactly: HELLO", {
    onEvent: (event) => {
      if (event.ev === "text_delta") events.push(event.text);
      else if (event.ev !== "token_usage") events.push(`[${event.ev}]`);
    },
  });
  console.log("run text:", JSON.stringify(result.text));
  console.log("streamed text:", JSON.stringify(events.join("")));

  const sessions = await client.listSessions();
  console.log("listSessions count:", sessions.length);
  const mine = sessions.find((s) => s.session_id === session_id);
  console.log("my session:", mine ? JSON.stringify(mine) : "MISSING");

  const history = await client.getHistory(session_id);
  console.log("history length:", history.length);

  await client.close();
  console.log("SMOKE OK");
  process.exit(0);
}

main().catch((error) => {
  console.error("SMOKE FAILED:", error);
  process.exit(1);
});
