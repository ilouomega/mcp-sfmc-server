const express = require('express');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/mcp/sse', async (req, res) => {
  console.log('Copilot Studio se ha conectado vía SSE');
  const transport = new SSEServerTransport('/mcp/messages', res);

  const mcpProcess = spawn('npx', ['-y', 'mcp-server-sfmc'], {
    env: {
      ...process.env,
      SFMC_CLIENT_ID: process.env.SFMC_CLIENT_ID,
      SFMC_CLIENT_SECRET: process.env.SFMC_CLIENT_SECRET,
      SFMC_SUBDOMAIN: process.env.SFMC_SUBDOMAIN,
      SFMC_MID: process.env.SFMC_MID
    }
  });

  await transport.start();
});

app.listen(PORT, () => console.log(`Servidor MCP escuchando en puerto ${PORT}`));