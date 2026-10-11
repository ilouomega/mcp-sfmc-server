import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

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

// 1. RUTA DE SALUD
app.get(['/', '/health'], (req, res) => {
  res.status(200).json({ status: "ok", server: "sfmc-mcp-server" });
});

// 2. MIDDLEWARE DE AUTENTICACIÓN POR API KEY
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/health')) return next();

  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const providedKey = apiKeyHeader || (authHeader ? authHeader.replace('Bearer ', '') : null);

  if (providedKey && providedKey === VALID_API_KEY) {
    return next();
  }

  console.warn(`[AUTH ERROR] Petición no autorizada en ${req.path}`);
  return res.status(401).json({ error: "Unauthorized", message: "API Key requerida" });
});

// 3. CONFIGURACIÓN DEL SERVIDOR MCP
const sessions = new Map();
const mcpServer = new Server(
  { name: "sfmc-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Manejador para Listar Herramientas
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS_DEFINITION };
});

// Manejador para EJECUTAR la Herramienta (AQUÍ ESTABA LA CLAVE)
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.log(`[MCP TOOL CALL] Ejecutando herramienta: ${request.params.name}`);

  if (request.params.name === "query_sfmc_engagement") {
    const days = request.params.arguments?.days || 30;
    const limit = request.params.arguments?.limit || 10;

    // Aquí irá tu consulta SQL real a SFMC a través de REST/SOAP API
    // Por ahora devolvemos la estructura de datos que espera el orquestador:
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            data_source: "Salesforce Marketing Cloud Data Views (_Sent, _Open, _Click)",
            timeframe_days: days,
            records_count: limit,
            results: [
              { SubscriberKey: "0035000002ABC1", Opens: 14, Clicks: 5, EngagementScore: "Alto", LastEventDate: "2026-10-10" },
              { SubscriberKey: "0035000002ABC2", Opens: 11, Clicks: 3, EngagementScore: "Alto", LastEventDate: "2026-10-09" },
              { SubscriberKey: "0035000002ABC3", Opens: 8, Clicks: 2, EngagementScore: "Medio", LastEventDate: "2026-10-08" }
            ]
          })
        }
      ]
    };
  }

  throw new Error(`Herramienta no encontrada: ${request.params.name}`);
});

// 4. RUTAS SSE Y MENSAJES
app.get(["/sse", "/mcp/sse"], async (req, res) => {
  console.log("[MCP SSE] Nueva conexión establecida");
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);

  req.on("close", () => sessions.delete(transport.sessionId));
  await mcpServer.connect(transport);
});

app.post(["/messages", "/mcp/messages", "/"], async (req, res) => {
  const sessionId = req.query.sessionId;

  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    await transport.handlePostMessage(req, res);
    return;
  }

  // Soporte directo JSON-RPC para Copilot Studio
  if (req.body && (req.body.method === 'initialize' || req.body.method === 'tools/list')) {
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

  return res.status(200).json({ status: "ready" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
