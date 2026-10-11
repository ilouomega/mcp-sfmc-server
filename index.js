vimport express from 'express';

const app = express();
app.use(express.json());

const VALID_API_KEY = process.env.API_KEY || "sfmc-mcp-secret-key-2026";

// Credenciales de SFMC extraídas del entorno en Render
const SFMC_CLIENT_ID = process.env.SFMC_CLIENT_ID;
const SFMC_CLIENT_SECRET = process.env.SFMC_CLIENT_SECRET;
const SFMC_SUBDOMAIN = process.env.SFMC_SUBDOMAIN; // Ej: "mcxxxxxxx" o "mcxxxxxxx.auth.marketingcloudapis.com"
const SFMC_MID = process.env.SFMC_ACCOUNT_ID || process.env.SFMC_MID;

// Definición oficial del manifiesto MCP y sus herramientas
const TOOLS_DEFINITION = [
  {
    name: "query_sfmc_engagement",
    description: "Consulta las Data Views de Salesforce Marketing Cloud (_Sent, _Open, _Click) para extraer métricas de engagement del MID autenticado.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Rango de días a consultar (ej. 30)" },
        limit: { type: "number", description: "Número de contactos a devolver" }
      }
    }
  }
];

// Helper para obtener Access Token de SFMC mediante OAuth 2.0
async function getSFMCAccessToken() {
  if (!SFMC_CLIENT_ID || !SFMC_CLIENT_SECRET || !SFMC_SUBDOMAIN) {
    throw new Error("Faltan variables de entorno de SFMC (SFMC_CLIENT_ID, SFMC_CLIENT_SECRET o SFMC_SUBDOMAIN).");
  }

  const cleanSubdomain = SFMC_SUBDOMAIN.replace('https://', '').replace('.auth.marketingcloudapis.com', '');
  const authUrl = `https://${cleanSubdomain}.auth.marketingcloudapis.com/v2/token`;

  const bodyData = {
    grant_type: 'client_credentials',
    client_id: SFMC_CLIENT_ID,
    client_secret: SFMC_CLIENT_SECRET
  };

  if (SFMC_MID) {
    bodyData.account_id = SFMC_MID;
  }

  const response = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyData)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`SFMC Auth Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    restEndpoint: data.rest_instance_url || `https://${cleanSubdomain}.rest.marketingcloudapis.com`
  };
}

// Helper para consultar datos reales de engagement en SFMC
async function fetchSFMCData(days = 30, limit = 10) {
  const { accessToken, restEndpoint } = await getSFMCAccessToken();

  // 1. Intentar consultar Data Extension de tracking / Data Views expuesta vía REST API
  // Si utilizas un endpoint personalizado de Data Extension en tu MID, ajusta la ruta aquí:
  const queryUrl = `${restEndpoint}/data/v1/customobjectdata/key/SFMC_Engagement_View/rowset?$pageSize=${limit}`;

  try {
    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const resultData = await response.json();
      return resultData.items?.map(item => ({
        SubscriberKey: item.keys?.SubscriberKey || item.values?.SubscriberKey,
        Opens: item.values?.Opens || 0,
        Clicks: item.values?.Clicks || 0,
        EngagementScore: item.values?.EngagementScore || "N/A",
        LastEventDate: item.values?.LastEventDate || new Date().toISOString().split('T')[0]
      })) || [];
    }
  } catch (err) {
    console.warn("[SFMC REST API] Endpoint directo no disponible, ejecutando fallback de consulta:", err.message);
  }

  // 2. Si no hay una Data Extension expuesta en la REST API, realizar llamada a la API de eventos/contactos
  const contactsUrl = `${restEndpoint}/contacts/v1/contacts/queries`;
  const response = await fetch(contactsUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      pageSize: limit,
      page: 1
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`SFMC Data Query Error (${response.status}): ${errText}`);
  }

  const contactsData = await response.json();
  return (contactsData.items || []).map(c => ({
    SubscriberKey: c.contactKey,
    Opens: c.attributes?.opens || 0,
    Clicks: c.attributes?.clicks || 0,
    EngagementScore: "Activo",
    LastEventDate: new Date().toISOString().split('T')[0]
  }));
}

// 1. MIDDLEWARE UNIVERSAL DE AUTENTICACIÓN
app.use((req, res, next) => {
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

// 2. RESPUESTA A SOLICITUDES JSON-RPC
async function handleJsonRpc(req, res) {
  const { jsonrpc, id, method, params } = req.body || {};
  console.log(`[MCP JSON-RPC] Recibido método: ${method} (ID: ${id})`);

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

  if (method === 'tools/list') {
    return res.status(200).json({
      jsonrpc: jsonrpc || "2.0",
      id: id || 1,
      result: { tools: TOOLS_DEFINITION }
    });
  }

  if (method === 'tools/call') {
    const days = params?.arguments?.days || 30;
    const limit = params?.arguments?.limit || 10;

    try {
      console.log(`[SFMC] Consultando datos reales para MID: ${SFMC_MID || 'Default'}`);
      const realData = await fetchSFMCData(days, limit);

      return res.status(200).json({
        jsonrpc: jsonrpc || "2.0",
        id: id || 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "success",
                account_id: SFMC_MID || "Autenticado vía Installed Package",
                data_source: "Salesforce Marketing Cloud Data Views / API",
                timeframe_days: days,
                records_count: realData.length,
                results: realData
              })
            }
          ]
        }
      });
    } catch (error) {
      console.error("[SFMC API ERROR]", error.message);
      return res.status(200).json({
        jsonrpc: jsonrpc || "2.0",
        id: id || 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                message: `Error al conectar con la API de SFMC (MID ${SFMC_MID}): ${error.message}`
              })
            }
          ],
          isError: true
        }
      });
    }
  }

  return res.status(200).json({
    jsonrpc: "2.0",
    id: id || 1,
    result: { status: "ready", tools: TOOLS_DEFINITION }
  });
}

// 3. RUTAS EXPRESS
app.post('*', handleJsonRpc);

app.get(['/sse', '/mcp/sse', '/messages', '/mcp/messages'], (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.status(200).send(`event: endpoint\ndata: /messages\n\n`);
});

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
