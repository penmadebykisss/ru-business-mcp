// Дымовой тест: запускает сервер как MCP-клиент и вызывает инструменты на реальных данных.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/index.js'] }));

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map(t => t.name).join(', '));

let failed = 0;
if (tools.length !== 10) { console.log(`FAIL ожидалось 10 инструментов, получено ${tools.length}`); failed++; }
// SMOKE_OFFLINE=1 — только офлайн-инструменты (для CI: ФНС и ЦБ могут не пускать зарубежные IP)
const OFFLINE = process.env.SMOKE_OFFLINE === '1';
async function run(name, args, check) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || '';
  let ok;
  try { ok = check(r.isError ? null : JSON.parse(text), text, r.isError); } catch { ok = false; }
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} (${Date.now() - t0} мс): ${text.replace(/\s+/g, ' ').slice(0, 220)}`);
}

await run('validate_requisites', { inn: '7707083893', ogrn: '1027700132195', bik: '044525225', account: '40702810938000000000' },
  d => d.inn.valid && d.ogrn.valid && d.bik.valid && d.account.valid !== undefined);
await run('validate_requisites', { inn: '7707083894' }, d => d.inn.valid === false);
if (!OFFLINE) {
await run('company_check', { id: '7707083893' }, d => d.found && d.results[0].ogrn === '1027700132195' && d.results[0].status === 'действует');
await run('company_check', { id: '1234567890' }, d => d.found === false);
await run('bank_by_bik', { bik: '044525225' }, d => d.correspondent_account === '30101810400000000225');
await run('cbr_rates', { codes: ['USD', 'EUR', 'CNY'] }, d => d.rates.length === 3 && d.rates.every(r => r.per_unit_rub > 0));
await run('cbr_rate_history', { code: 'USD' }, d => d.points.length > 10 && d.min_rub > 0);
await run('currency_convert', { amount: 1000, from: 'USD', to: 'RUB' }, d => d.result > 1000);
await run('cbr_key_rate', {}, d => d.current_pct > 0 && d.changes.length >= 1);
await run('late_payment_penalty', { amount: 100000, from: '2026-01-01', to: '2026-03-31' }, d => d.days === 90 && d.total_rub > 0);
await run('work_calendar', { year: 2026, month: 1 }, d => d.work_days > 10 && d.holidays_on_weekdays.length > 0);
await run('work_calendar', { year: 2026 }, d => d.work_days > 240 && d.months.length === 12);
await run('work_days_calc', { operation: 'add', date: '2026-04-29', days: 5 }, d => d.result >= '2026-05-07');
await run('work_days_calc', { operation: 'between', date: '2026-05-01', to: '2026-05-31' }, d => d.work_days < 21);
}

await client.close();
console.log(failed ? `\nПровалено: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
