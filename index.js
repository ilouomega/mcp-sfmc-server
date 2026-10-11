import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

// 1. LOGGER DE DIAGNÒSTIC (Mostra totes les peticions a la consola de Render)
app.use((req, res, next) => {
  console.log(`[PETICIÓ ENTRANTS] ${req.method} ${req.url} - Headers:`, JSON.stringify({
    'x-api-key': req.headers['x-api-key'],
    'content-type': req.headers['content-type'],
    'user-agent': req.headers['user-agent']
  }));
  next();
});

const VALID_API_KEY = process.env.API_KEY || "sfmc-mcp-secret-key-2026";

const TOOLS_DEFINITION = [
  {
    name: "query_sfmc_engagement",
    description: "Consulta les Data Views de Salesforce Marketing Cloud (_Sent, _Open, _Click) per extreure mètriques d'engagement.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Rango de días a consultar (ej. 30)" },
        limit: { type: "number", description: "Número de contactos a devolver" }
      }
    }
  }
];

// 2. RUTES DE SALUT
app.get(['/', '/health', '/mcp'], (req, res) => {
  res.status(200).json({ status: "ok", server: "sfmc-mcp-server", tools: TOOLS_DEFINITION });
});

// 3. MIDDLEWARE D'AUTENTICACIÓ
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/health')) return next();

  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const providedKey = apiKeyHeader || (authHeader ? authHeader.replace('Bearer ', '') : null);

  if (providedKey && providedKey === VALID_API_KEY) {
    return next();
  }

  console.warn(`[AUTH ERROR] Clau no vàlida a ${req.path}`);
  return res.status(401).json({ error: "Unauthorized", message: "API Key requerida" });
});

// 4. SERVIDOR MCP
const sessions = new Map();
const mcpServer = new Server(
  { name: "sfmc-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS_DEFINITION };
});

// 5. ATENDRE SSE I MANIFEST A QUALSEVOL RUTA
app.get(["/sse", "/mcp/sse", "*/sse"], async (req, res) => {
  console.log("[MCP] Conexió SSE iniciada");
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);

  req.on("close", () => sessions.delete(transport.sessionId));
  await mcpServer.connect(transport);
});

// Respostes per a peticions POST
app.all("*", async (req, res) => {
  const sessionId = req.query.sessionId;
  
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    await transport.handlePostMessage(req, res);
    return;
  }

  // Resposta per defecte per evitar qualsevol 404 en la negociació inicial de Power Platform
  console.log(`[MCP HANDSHAKE] Responent 200 OK a ${req.method} ${req.path}`);
  return res.status(200).json({
    jsonrpc: "2.0",
    id: req.body?.id || 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "sfmc-mcp-server", version: "1.0.0" },
      tools: TOOLS_DEFINITION
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
