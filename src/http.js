// Облачный режим: MCP по Streamable HTTP для удалённых клиентов — MCP Hub Битрикс24, Claude, ChatGPT, n8n.
// Адрес: https://<хост>/mcp. Данные открытые, поэтому по умолчанию ключ не нужен; если задать MCP_API_KEYS
// (ключи через запятую), сервер будет требовать заголовок Authorization: Bearer <ключ>.
// Защита от перегрузки — лимит запросов в минуту с одного IP (RATE_PER_MIN).

import http from 'node:http';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, VERSION } from './server.js';

// Node 18: библиотеке MCP нужен глобальный Web Crypto
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const PORT = Number(process.env.MCP_HTTP_PORT || process.env.PORT || 8788);
// По умолчанию только localhost: наружу — через HTTPS-прокси (Caddy). 0.0.0.0 — если прокси на другой машине.
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';
const MAX_PER_MIN = Number(process.env.RATE_PER_MIN || 60);
const KEYS = (process.env.MCP_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
};

function keyOk(key) {
  if (!KEYS.length) return true;
  if (!key) return false;
  const b = Buffer.from(key);
  // Сравнение за постоянное время, чтобы ключ нельзя было подобрать по задержке
  return KEYS.some(k => { const a = Buffer.from(k); return a.length === b.length && crypto.timingSafeEqual(a, b); });
}

const hits = new Map();
function rateOk(ip) {
  const now = Date.now(), win = hits.get(ip)?.filter(t => now - t < 60e3) || [];
  win.push(now); hits.set(ip, win);
  if (hits.size > 10000) for (const [k, v] of hits) if (now - v[v.length - 1] > 60e3) hits.delete(k);
  return win.length <= MAX_PER_MIN;
}

function send(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra });
  res.end(JSON.stringify(obj));
}
const rpcError = (res, status, message, extra) => send(res, status, { jsonrpc: '2.0', error: { code: -32001, message }, id: null }, extra);

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) throw new Error('Слишком большой запрос'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

export function handler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname === '/health') return send(res, 200, { ok: true, name: 'ru-business-mcp', version: VERSION });
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'Not found. MCP endpoint: /mcp' });
    // Проверки доступности адреса (HEAD, браузер) получают 200; поток SSE по GET сервер без сессий не держит
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS }); return res.end(); }
    if (req.method === 'GET' && !String(req.headers.accept || '').includes('text/event-stream'))
      return send(res, 200, { name: 'ru-business-mcp', version: VERSION, transport: 'streamable-http', usage: 'POST /mcp (JSON-RPC)' });
    if (req.method !== 'POST') return rpcError(res, 405, 'Используйте POST /mcp (Streamable HTTP, без сессий)', { Allow: 'POST, OPTIONS' });

    // Ключ принимается и как Authorization: Bearer, и как X-API-Key — разные клиенты передают его по-разному
    const key = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '').trim();
    if (!keyOk(key)) return rpcError(res, 401, 'Нужен ключ доступа: заголовок Authorization: Bearer <ключ>');
    if (!rateOk(clientIp(req))) return rpcError(res, 429, `Не больше ${MAX_PER_MIN} запросов в минуту`, { 'Retry-After': '60' });

    let body;
    try { body = await readBody(req); } catch (e) { return rpcError(res, 400, e.message); }

    // Без сессий: на каждый запрос — свой экземпляр сервера и транспорта
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

export async function startHttp() {
  const srv = http.createServer(handler());
  await new Promise(r => srv.listen(PORT, HOST, r));
  console.error(`ru-business-mcp ${VERSION}: HTTP на ${HOST}:${PORT}, ${KEYS.length ? `ключей: ${KEYS.length}` : 'публичный доступ'}, лимит ${MAX_PER_MIN}/мин с IP`);
  return srv;
}
