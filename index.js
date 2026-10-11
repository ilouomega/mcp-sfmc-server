import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

// 1. RUTA DE SALUD Y COMPROBACIÓN BÁSICA (Evita 404 en sondeos de Copilot)
app.get(['/', '/health', '/mcp'], (req, res) => {
  res.status(200).json({ status: "ok", server: "sfmc-mcp-server" });
});

// 2. MIDDLEWARE DE AUTENTICACIÓN POR API KEY
const VALID_API_KEY = process.env.API_KEY || "sfmc-mcp-secret-key-2026";

app.use((req, res, next) => {
  // Ignorar autenticación solo para la ruta libre de salud
  if (req.path === '/' || req.path === '/health') return next();

  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const providedKey = apiKeyHeader || (authHeader ? authHeader.replace('Bearer ', '') : null);

  if (providedKey && providedKey === VALID_API_KEY) {
    return next();
  }

  console.warn(`[AUTH] Intento no autorizado desde IP ${req.ip} a ${req.path}`);
  return res.status(401).json({ error: "Unauthorized", message: "Clave de API inválida o no proporcionada" });
});

// 3. CONFIGURACIÓN DEL SERVIDOR MCP
const sessions = new Map();

const mcpServer = new Server(
  { name: "sfmc-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

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

// 4. ENDPOINTS SSE Y MESSAGES (Aceptan múltiples variaciones de ruta)
app.get(["/sse", "/mcp/sse"], async (req, res) => {
  console.log("[MCP] Nueva conexión SSE entrante...");
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);

  req.on("close", () => {
    sessions.delete(transport.sessionId);
  });

  await mcpServer.connect(transport);
});

app.post(["/messages", "/mcp/messages"], async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessions.get(sessionId);

  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
