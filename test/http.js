// Тест облачного режима: сервер в режиме --http, клиент по Streamable HTTP; публичный доступ, CORS, ключи, лимит.
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Node 18: библиотеке MCP нужен глобальный Web Crypto
if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function start(extraEnv) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, ['src/index.js', '--http'], {
    env: { ...process.env, MCP_HTTP_PORT: String(port), ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    proc.stderr.on('data', d => { if (String(d).includes('HTTP на')) resolve(); });
    proc.on('exit', c => reject(new Error('сервер завершился: ' + c)));
    setTimeout(() => reject(new Error('сервер не запустился')), 10000);
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

let failed = 0;
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${info}`); };

// Публичный режим
const pub = await start({});
const client = new Client({ name: 'http-test', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(pub.base + '/mcp')));
const { tools } = await client.listTools();
check('список инструментов по HTTP', tools.length === 10, `(${tools.length})`);
const r = await client.callTool({ name: 'validate_requisites', arguments: { inn: '7707083893', bik: '044525225' } });
const d = JSON.parse(r.content[0].text);
check('вызов инструмента по HTTP', d.inn.valid && d.bik.valid);
await client.close();

const health = await (await fetch(pub.base + '/health')).json();
check('/health', health.ok && health.name === 'ru-business-mcp');
const pre = await fetch(pub.base + '/mcp', { method: 'OPTIONS' });
check('CORS preflight', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*');
const head = await fetch(pub.base + '/mcp', { method: 'HEAD' });
check('HEAD /mcp → 200 (проверка адреса маркетплейсом)', head.status === 200);
const get = await fetch(pub.base + '/mcp');
check('GET /mcp → 200 с описанием', get.status === 200 && (await get.json()).transport === 'streamable-http');
const sse = await fetch(pub.base + '/mcp', { headers: { Accept: 'text/event-stream' } });
check('GET /mcp SSE → 405', sse.status === 405);
pub.proc.kill();

// Режим с ключами и маленьким лимитом
const priv = await start({ MCP_API_KEYS: 'k1,k2', RATE_PER_MIN: '4' });
const init = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const post = (auth) => fetch(priv.base + '/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) },
  body: JSON.stringify(init),
});
check('без ключа → 401', (await post()).status === 401);
check('чужой ключ → 401', (await post('k3')).status === 401);
const okResp = await post('k2');
check('верный ключ → 200', okResp.status === 200);
const viaHeader = await fetch(priv.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-API-Key': 'k1' }, body: JSON.stringify(init) });
check('ключ в X-API-Key → 200', viaHeader.status === 200);
await post('k1'); await post('k1');
check('лимит запросов → 429', (await post('k1')).status === 429);
priv.proc.kill();

console.log(failed ? `\nПровалено: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
