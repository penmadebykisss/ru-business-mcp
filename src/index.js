#!/usr/bin/env node
// Точка входа: локальный режим (stdio) или облачный (--http, Streamable HTTP для удалённых клиентов,
// например MCP Hub в Битрикс24, Claude и ChatGPT по ссылке).

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

if (process.argv.includes('--http') || process.env.MCP_HTTP_PORT) {
  const { startHttp } = await import('./http.js');
  await startHttp();
} else {
  await createServer().connect(new StdioServerTransport());
}
