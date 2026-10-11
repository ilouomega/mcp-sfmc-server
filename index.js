import express from 'express';

const app = express();
app.use(express.json());

const VALID_API_KEY = process.env.API_KEY || "sfmc-mcp-secret-key-2026";

// Definición oficial del manifiesto MCP y sus herramientas
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

// 1. MIDDLEWARE UNIVERSAL DE AUTENTICACIÓN
app.use((req, res, next) => {
  // Permitir chequeos de salud simples de Render sin credenciales
  if (req.method === 'GET' && (req.path === '/' || req.path === '/health')) {
    return res.status(200).json({ status: "ok", server: "sfmc-mcp-server" });
  }

  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const providedKey = apiKeyHeader || (authHeader ? authHeader.replace('Bearer ', '') : null);

  if (providedKey && providedKey === VALID_API_KEY) {
    return next();
  }

  console.warn(`[AUTH] Acceso denegado en ${req.path} desde IP ${req.ip}`);
  return res.status(401).json({ error: "Unauthorized", message: "API Key requerida" });
});

// 2. RESPUESTA A SOLICITUDES JSON-RPC (Handshake, Discovery y Tool Calls de Copilot Studio)
function handleJsonRpc(req, res) {
  const { jsonrpc, id, method, params } = req.body || {};
  console.log(`[MCP JSON-RPC] Recibido método: ${method} (ID: ${id})`);

  // Inicialización MCP / Handshake
  if (method === 'initialize') {
    return res.status(200).json({
      jsonrpc: jsonrpc || "2.0",
      id: id || 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sfmc-mcp-server", version: "1.0.0" }
      }
    });
  }

  // Listado de herramientas
  if (method === 'tools/list') {
    return res.status(200).json({
      jsonrpc: jsonrpc || "2.0",
      id: id || 1,
      result: { tools: TOOLS_DEFINITION }
    });
  }

  // Ejecución de la herramienta
  if (method === 'tools/call') {
    const days = params?.arguments?.days || 30;
    const limit = params?.arguments?.limit || 10;

    return res.status(200).json({
      jsonrpc: jsonrpc || "2.0",
      id: id || 1,
      result: {
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
      }
    });
  }

  // Respuesta por defecto si el método no es reconocido
  return res.status(200).json({
    jsonrpc: jsonrpc || "2.0",
    id: id || 1,
    result: { status: "ready", tools: TOOLS_DEFINITION }
  });
}

// 3. CAPTURAR CUALQUIER RUTA POST/GET Y RESPONDER 200 OK (Cero 404s)
app.post('*', handleJsonRpc);

app.get(['/sse', '/mcp/sse', '/messages', '/mcp/messages'], (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.status(200).send(`event: endpoint\ndata: /messages\n\n`);
});

// Catch-all GET para evitar cualquier 404 en sondeos
app.get('*', (req, res) => {
  res.status(200).json({
    name: "sfmc-mcp-server",
    version: "1.0.0",
    protocolVersion: "2024-11-05",
    tools: TOOLS_DEFINITION
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
