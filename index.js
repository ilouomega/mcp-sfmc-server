import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const app = express();
app.use(express.json());

// Mapa para gestionar sesiones activas
const transports = new Map();

// 1. Endpoint para iniciar la conexión SSE (debe soportar /sse y /mcp/sse)
app.get(["/sse", "/mcp/sse"], async (req, res) => {
  console.log("Nueva conexión SSE entrante desde Copilot Studio...");
  
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  await server.connect(transport);

  req.on("close", () => {
    transports.delete(transport.sessionId);
  });
});

// 2. Endpoint para recibir mensajes POST JSON-RPC (debe soportar /messages y /mcp/messages)
app.post(["/messages", "/mcp/messages"], async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MCP Server running on port ${PORT}`));
