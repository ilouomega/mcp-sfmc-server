import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

// -------------------------------------------------------------
// 1. RUTA DE SALUD LIBRE (Para comprobaciones rápidas)
// -------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// -------------------------------------------------------------
// 2. MIDDLEWARE DE AUTENTICACIÓN POR API KEY
// -------------------------------------------------------------
const VALID_API_KEY = process.env.API_KEY || "mi_clave_secreta_sfmc_12345";

app.use((req, res, next) => {
  // Copilot Studio enviará la clave en x-api-key o mediante Authorization Header
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];

  const providedKey = apiKeyHeader || (authHeader ? authHeader.replace('Bearer ', '') : null);

  // Si coincide la clave, dejamos pasar la petición
  if (providedKey && providedKey === VALID_API_KEY) {
    return next();
  }

  // Si falla o no viene la clave, devolvemos 401 Unauthorized
  console.warn(`[AUTH] Acceso rechazado desde IP ${req.ip} a ${req.path}`);
  return res.status(401).json({ 
    error: "Unauthorized", 
    message: "Falta la API Key o es incorrecta en el encabezado x-api-key" 
  });
});

// -------------------------------------------------------------
// 3. CONFIGURACIÓN DEL SERVIDOR MCP Y SUS RUTAS PROTEGIDAS
// -------------------------------------------------------------
const sessions = new Map();

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
    res.status(404).json({ error: "Session not found" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
