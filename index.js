const express = require('express');

const app = express();
app.use(express.json());

const VALID_API_KEY = process.env.API_KEY || "sfmc-mcp-secret-key-2026";

const SFMC_CLIENT_ID = process.env.SFMC_CLIENT_ID;
const SFMC_CLIENT_SECRET = process.env.SFMC_CLIENT_SECRET;
const SFMC_SUBDOMAIN = process.env.SFMC_SUBDOMAIN;
const SFMC_MID = process.env.SFMC_ACCOUNT_ID || process.env.SFMC_MID;

// Definición ampliada del manifiesto de herramientas MCP
const TOOLS_DEFINITION = [
  {
    name: "query_sfmc_engagement",
    description: "Consulta el engagement general, ranking de contactos, JobID y nombre de campaña en SFMC.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Rango de días a consultar" },
        limit: { type: "number", description: "Número de contactos a devolver" }
      }
    }
  },
  {
    name: "query_sfmc_temporal_patterns",
    description: "Analiza patrones temporales por campaña: horas/días de mejor apertura y demoras de interacción.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Número de campañas a analizar" }
      }
    }
  },
  {
    name: "query_sfmc_fatigue_and_health",
    description: "Evalúa la fatiga de envíos, tasa de rebotes y calcula el Health Score general (0-100).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Número de contactos a revisar" }
      }
    }
  },
  {
    name: "query_sfmc_domain_analysis",
    description: "Analiza el rendimiento por dominio de correo (@gmail.com, @hotmail.com) y detecta anomalías.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

// Tokenizador OAuth 2.0
async function getSFMCAccessToken() {
  if (!SFMC_CLIENT_ID || !SFMC_CLIENT_SECRET || !SFMC_SUBDOMAIN) {
    throw new Error("Faltan variables de entorno de SFMC en Render.");
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

// Extractor genérico vía SOAP a DataExtensionObject[SFMC_Analytics_Master]
async function fetchAnalyticsData(accessToken, soapEndpoint, properties, limit = 50) {
  const propsXml = properties.map(p => `<Properties>${p}</Properties>`).join('\n');

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
                <ObjectType>DataExtensionObject[SFMC_Analytics_Master]</ObjectType>
                <Client>
                    <ClientID>${SFMC_MID || '7295121'}</ClientID>
                </Client>
                ${propsXml}
            </RetrieveRequest>
        </RetrieveRequestMsg>
    </s:Body>
</s:Envelope>`;

  const response = await fetch(soapEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'Retrieve' },
    body: soapEnvelope
  });

  const xmlText = await response.text();
  const matches = xmlText.match(/<Results[\s\S]*?<\/Results>/g) || [];

  return matches.slice(0, limit).map(resultXml => {
    const record = {};
    properties.forEach(prop => {
      const reg = new RegExp(`<Name>${prop}<\/Name>\\s*<Value>(.*?)<\/Value>`, 'i');
      const m = resultXml.match(reg);
      record[prop] = m ? m[1] : '';
    });
    return record;
  });
}

// Middleware Auth Header MCP
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

  return res.status(401).json({ error: "Unauthorized", message: "API Key requerida" });
});

// JSON-RPC Request Handler
async function handleJsonRpc(req, res) {
  const { jsonrpc, id, method, params } = req.body || {};

  if (method === 'initialize') {
    return res.status(200).json({
      jsonrpc: jsonrpc || "2.0",
      id: id || 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sfmc-mcp-server", version: "2.1.0" }
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
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      const { accessToken, soapEndpoint } = await getSFMCAccessToken();
      let payload = {};

      if (toolName === 'query_sfmc_engagement') {
        const fields = ['SubscriberKey', 'JobID', 'CampaignName', 'EmailName', 'EmailSubject', 'TotalOpens', 'TotalClicks', 'EngagementScore', 'LastEventDate'];
        const records = await fetchAnalyticsData(accessToken, soapEndpoint, fields, args.limit || 10);
        payload = { status: "success", tool: toolName, records_count: records.length, results: records };
      } 
      else if (toolName === 'query_sfmc_temporal_patterns') {
        const fields = ['JobID', 'CampaignName', 'EmailName', 'AvgSendHour', 'AvgSendDayOfWeek', 'AvgOpenDelayMinutes', 'AvgClickDelayMinutes'];
        const records = await fetchAnalyticsData(accessToken, soapEndpoint, fields, args.limit || 10);
        payload = { status: "success", tool: toolName, patterns: records };
      }
      else if (toolName === 'query_sfmc_fatigue_and_health') {
        const fields = ['SubscriberKey', 'TotalSent', 'TotalOpens', 'TotalBounces', 'FatigueIndex'];
        const records = await fetchAnalyticsData(accessToken, soapEndpoint, fields, args.limit || 20);
        payload = { status: "success", tool: toolName, fatigue_data: records };
      }
      else if (toolName === 'query_sfmc_domain_analysis') {
        const fields = ['Domain', 'TotalOpens', 'TotalClicks', 'TotalBounces'];
        const records = await fetchAnalyticsData(accessToken, soapEndpoint, fields, 50);
        payload = { status: "success", tool: toolName, domain_data: records };
      }
      else {
        throw new Error(`Herramienta no encontrada: ${toolName}`);
      }

      return res.status(200).json({
        jsonrpc: jsonrpc || "2.0",
        id: id || 1,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload) }]
        }
      });

    } catch (error) {
      console.error("[MCP SERVER ERROR]", error.message);
      return res.status(200).json({
        jsonrpc: jsonrpc || "2.0",
        id: id || 1,
        result: {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: error.message }) }],
          isError: true
        }
      });
    }
  }

  return res.status(200).json({ jsonrpc: "2.0", id: id || 1, result: { status: "ready", tools: TOOLS_DEFINITION } });
}

app.post('*', handleJsonRpc);

app.get(['/sse', '/mcp/sse', '/messages', '/mcp/messages'], (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.status(200).send(`event: endpoint\ndata: /messages\n\n`);
});

app.get('*', (req, res) => {
  res.status(200).json({ name: "sfmc-mcp-server", version: "2.1.0", tools: TOOLS_DEFINITION });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
