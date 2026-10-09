import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

// Mapa de sesiones SSE
const sessions = new Map();

// Crear servidor MCP
const mcpServer = new Server(
  { name: "sfmc-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Declarar las herramientas para que Copilot Studio pueda descubrirlas
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query_sfmc_engagement",
        description: "Consulta las Data Views de Salesforce Marketing Cloud (_Sent, _Open, _Click) para extraer métricas de engagement.",
        inputSchema: {
          type: "object",
          properties: {
            days: { type: "number", description: "Rango de días a consultar (ej. 30)" },
            limit: { type: "number", description: "Número de contactos a devolver" }
          }
        }
      }
    ]
  };
});

// Endpoint SSE
app.get(["/sse", "/mcp/sse"], async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);

  req.on("close", () => {
    sessions.delete(transport.sessionId);
  });

  await mcpServer.connect(transport);
});

// Endpoint para recibir los mensajes POST del cliente (Copilot Studio)
app.post(["/messages", "/mcp/messages"], async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessions.get(sessionId);

  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    // Si la sesión caduca o no coincide la ruta
    res.status(404).json({ error: "Session not found" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
