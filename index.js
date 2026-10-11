import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

// Clave de API configurada en Render
const VALID_API_KEY = process.env.API_KEY || "sfmc-mcp-secret-key-2026";

// Definición pública de las herramientas para auto-descubrimiento
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

// 1. MIDDLEWARE DE AUTENTICACIÓN
app.use((req, res, next) => {
  // Permitir chequeos de salud simples en la raíz sin credenciales
  if (req.method === 'GET' && (req.path === '/' || req.path === '/health')) {
    return res.status(200).json({ status: "ok", server: "sfmc-mcp-server" });
  }

  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const providedKey = apiKeyHeader || (authHeader ? authHeader.replace('Bearer ', '') : null);

  if (providedKey && providedKey === VALID_API_KEY) {
    return next();
  }

  console.warn(`[AUTH ERROR] Petición rechazada en ${req.path} desde IP: ${req.ip}`);
  return res.status(401).json({ error: "Unauthorized", message: "API Key requerida" });
});

// 2. RESPONDER A RUTAS DE DESCUBRIMIENTO QUE COPILOT PUEDA PROBAR (Evita el 404)
app.get(['/mcp', '/.well-known/mcp.json', '/tools', '/v1/tools'], (req, res) => {
  res.status(200).json({
    name: "sfmc-mcp-server",
    version: "1.0.0",
    protocolVersion: "2024-11-05",
    tools: TOOLS_DEFINITION
  });
});

// 3. CONFIGURACIÓN DEL SERVIDOR MCP OFICIAL
const sessions = new Map();
const mcpServer = new Server(
  { name: "sfmc-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS_DEFINITION };
});

// 4. ENDPOINTS SSE Y MESSAGES
app.get(["/sse", "/mcp/sse"], async (req, res) => {
  console.log("[MCP] Conexión SSE iniciada correctamente por Copilot Studio");
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
    // Si la sesión aún no se ha creado por SSE, devolver OK básico para evitar 404 en sondas
    res.status(200).json({ status: "ready" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
