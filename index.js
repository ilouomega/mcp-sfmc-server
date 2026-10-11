import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

// Clave de API configurada en Render
const VALID_API_KEY = process.env.API_KEY || "sfmc-mcp-secret-key-2026";

const TOOLS_DEFINITION = [
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
];

// 1. CHEQUEO DE SALUD LIBRE (Para probes de Render / Azure)
app.get(['/', '/health'], (req, res) => {
  res.status(200).json({ status: "ok", server: "sfmc-mcp-server" });
});

// 2. MIDDLEWARE DE AUTENTICACIÓN
app.use((req, res, next) => {
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const providedKey = apiKeyHeader || (authHeader ? authHeader.replace('Bearer ', '') : null);

  if (providedKey && providedKey === VALID_API_KEY) {
    return next();
  }

  console.warn(`[AUTH ERROR] Petición rechazada en ${req.path} desde IP: ${req.ip}`);
  return res.status(401).json({ error: "Unauthorized", message: "API Key inválida o no proporcionada" });
});

// 3. CONFIGURACIÓN DEL SERVIDOR MCP
const sessions = new Map();
const mcpServer = new Server(
  { name: "sfmc-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS_DEFINITION };
});

// 4. ENDPOINTS SSE Y MANEJO DE MENSAJES (Soporta handshake directo de Copilot Studio)
app.get(["/sse", "/mcp/sse"], async (req, res) => {
  console.log("[MCP] Conexión SSE solicitada por Copilot Studio");
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);

  req.on("close", () => {
    sessions.delete(transport.sessionId);
  });

  await mcpServer.connect(transport);
});

// POST que gestiona tanto los mensajes de sesión SSE como las peticiones de inicialización directa
app.post(["/", "/messages", "/mcp/messages"], async (req, res) => {
  const sessionId = req.query.sessionId;
  
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    await transport.handlePostMessage(req, res);
    return;
  }

  // Si Copilot Studio envía el handshake sin sessionId previo, responder HTTP 200 OK
  if (req.body && (req.body.method === 'initialize' || req.body.method === 'tools/list')) {
    console.log(`[MCP] Handshake inicial de Copilot Studio recibido (${req.body.method})`);
    return res.status(200).json({
      jsonrpc: "2.0",
      id: req.body.id || 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sfmc-mcp-server", version: "1.0.0" },
        tools: TOOLS_DEFINITION
      }
    });
  }

  // Respuesta por defecto para no devolver 404 en sondas de salud o validación
  return res.status(200).json({ status: "ready", tools: TOOLS_DEFINITION });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
