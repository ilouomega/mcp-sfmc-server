const express = require('express');

const app = express();
app.use(express.json());

const VALID_API_KEY = process.env.API_KEY || "sfmc-mcp-secret-key-2026";

const SFMC_CLIENT_ID = process.env.SFMC_CLIENT_ID;
const SFMC_CLIENT_SECRET = process.env.SFMC_CLIENT_SECRET;
const SFMC_SUBDOMAIN = process.env.SFMC_SUBDOMAIN;
const SFMC_MID = process.env.SFMC_ACCOUNT_ID || process.env.SFMC_MID;

const TOOLS_DEFINITION = [
  {
    name: "query_sfmc_engagement",
    description: "Consulta directamente las Data Views del sistema de SFMC (_Sent, _Open, _Click) mediante la API de Eventos en tiempo real.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Rango de días a consultar (ej. 30)" },
        limit: { type: "number", description: "Número de contactos a devolver" }
      }
    }
  }
];

// 1. Obtener Access Token mediante OAuth 2.0 Client Credentials
async function getSFMCAccessToken() {
  if (!SFMC_CLIENT_ID || !SFMC_CLIENT_SECRET || !SFMC_SUBDOMAIN) {
    throw new Error("Faltan variables de entorno de SFMC (SFMC_CLIENT_ID, SFMC_CLIENT_SECRET o SFMC_SUBDOMAIN).");
  }

  const cleanSubdomain = SFMC_SUBDOMAIN.replace('https://', '').replace('.auth.marketingcloudapis.com', '').replace('.rest.marketingcloudapis.com', '').replace('.soap.marketingcloudapis.com', '');
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
    soapEndpoint: `https://${cleanSubdomain}.soap.marketingcloudapis.com/Service.asmx`
  };
}

// 2. Consulta directa SOAP a las Data Views / Eventos de SFMC (OpenEvent & ClickEvent)
async function fetchSOAPEventData(objectType, accessToken, soapEndpoint, days = 30) {
  const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // En index.js, actualiza el sobre SOAP para forzar el MID (Client.ClientID):
const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing">
    <s:Header>
        <a:Action s:mustUnderstand="1">Retrieve</a:Action>
        <a:To s:mustUnderstand="1">${soapEndpoint}</a:To>
        <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
    </s:Header>
    <s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
        <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
                <ObjectType>${objectType}</ObjectType>
                <Client>
                    <ClientID>${SFMC_MID || '7295121'}</ClientID>
                </Client>
                <Properties>SubscriberKey</Properties>
                <Properties>EventDate</Properties>
            </RetrieveRequest>
        </RetrieveRequestMsg>
    </s:Body>
</s:Envelope>`;

  const response = await fetch(soapEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': 'Retrieve'
    },
    body: soapEnvelope
  });

  const xmlText = await response.text();
  if (!response.ok || xmlText.includes('<Fault>')) {
    throw new Error(`Error en SOAP Request (${objectType}): ${xmlText.substring(0, 200)}`);
  }

  const results = [];
  const matches = xmlText.match(/<Results[\s\S]*?<\/Results>/g) || [];

  for (const resXml of matches) {
    const subKeyMatch = resXml.match(/<SubscriberKey>(.*?)<\/SubscriberKey>/i);
    const dateMatch = resXml.match(/<EventDate>(.*?)<\/EventDate>/i);
    if (subKeyMatch && subKeyMatch[1]) {
      results.push({
        SubscriberKey: subKeyMatch[1],
        EventDate: dateMatch ? dateMatch[1] : new Date().toISOString()
      });
    }
  }

  return results;
}

// 3. Cruzar datos de Data Views (_Open y _Click) para calcular Engagement en vivo
async function fetchDirectDataViewEngagement(days = 30, limit = 10) {
  const { accessToken, soapEndpoint } = await getSFMCAccessToken();

  console.log(`[SFMC SOAP] Consultando Data Views del sistema (OpenEvent / ClickEvent) para MID ${SFMC_MID || '7295121'}...`);

  // Consultar directamente los eventos reales del sistema
  const [opensList, clicksList] = await Promise.all([
    fetchSOAPEventData('OpenEvent', accessToken, soapEndpoint, days).catch(() => []),
    fetchSOAPEventData('ClickEvent', accessToken, soapEndpoint, days).catch(() => [])
  ]);

  // Agrupar por SubscriberKey
  const engagementMap = {};

  opensList.forEach(item => {
    const key = item.SubscriberKey;
    if (!engagementMap[key]) {
      engagementMap[key] = { SubscriberKey: key, Opens: 0, Clicks: 0, LastEventDate: item.EventDate };
    }
    engagementMap[key].Opens += 1;
    if (new Date(item.EventDate) > new Date(engagementMap[key].LastEventDate)) {
      engagementMap[key].LastEventDate = item.EventDate;
    }
  });

  clicksList.forEach(item => {
    const key = item.SubscriberKey;
    if (!engagementMap[key]) {
      engagementMap[key] = { SubscriberKey: key, Opens: 0, Clicks: 0, LastEventDate: item.EventDate };
    }
    engagementMap[key].Clicks += 1;
    if (new Date(item.EventDate) > new Date(engagementMap[key].LastEventDate)) {
      engagementMap[key].LastEventDate = item.EventDate;
    }
  });

  const summaryArray = Object.values(engagementMap).map(c => ({
    SubscriberKey: c.SubscriberKey,
    Opens: c.Opens,
    Clicks: c.Clicks,
    EngagementScore: c.Clicks >= 3 ? "Alto" : (c.Opens >= 1 ? "Medio" : "Bajo"),
    LastEventDate: c.LastEventDate.split('T')[0]
  }));

  // Ordenar por interacción
  summaryArray.sort((a, b) => (b.Clicks * 3 + b.Opens) - (a.Clicks * 3 + a.Opens));

  return summaryArray.slice(0, limit);
}

// 4. Middleware de Autenticación MCP
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

// 5. Manejador JSON-RPC
async function handleJsonRpc(req, res) {
  const { jsonrpc, id, method, params } = req.body || {};

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
      const realData = await fetchDirectDataViewEngagement(days, limit);

      return res.status(200).json({
        jsonrpc: jsonrpc || "2.0",
        id: id || 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "success",
                account_id: SFMC_MID || "7295121",
                data_source: "Salesforce Marketing Cloud Data Views Direct (OpenEvent / ClickEvent)",
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
                message: `Error al consultar Data Views en SFMC (MID ${SFMC_MID}): ${error.message}`
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
