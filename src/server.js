// MCP-сервер «Бизнес-данные РФ»: проверка контрагентов (ЕГРЮЛ/ЕГРИП), курсы и ключевая ставка ЦБ,
// производственный календарь и справочник банков. Все источники открытые, токены не нужны.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as src from './sources.js';

export const VERSION = '1.2.0';

/** Новый экземпляр MCP-сервера со всеми инструментами. */
export function createServer() {
const server = new McpServer({ name: 'ru-business', version: VERSION }, {
  instructions: 'Официальные данные для работы с российским бизнесом, без токенов. Перед сделкой или выставлением счёта проверяйте ' +
    'контрагента через company_check (по ИНН или ОГРН; поиск по названию не поддерживается), опечатки в реквизитах — через validate_requisites. ' +
    'Суммы в валюте пересчитывайте currency_convert по курсу ЦБ на нужную дату. Для просрочек используйте late_payment_penalty — он сам ' +
    'учитывает изменения ключевой ставки. Сроки «в рабочих днях» считайте work_days_calc, а не календарными днями. ' +
    'Official Russian business data: company check by INN/OGRN, CBR rates and key rate, penalties, production calendar, banks by BIK.',
});

const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: 'Ошибка: ' + (e?.message || String(e)) }] });
const safe = fn => async args => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const today = () => src.iso(new Date());
const daysAgo = n => src.iso(new Date(Date.now() - n * 864e5));
const round = (x, n = 4) => Math.round(x * 10 ** n) / 10 ** n;

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Дата в формате ГГГГ-ММ-ДД');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const local = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ================= Контрагенты =================

server.registerTool('company_check', {
  title: 'Проверка контрагента по ИНН или ОГРН',
  description: 'Сведения из ЕГРЮЛ/ЕГРИП ФНС по ИНН или ОГРН организации или ИП: полное и краткое название, ИНН, ОГРН, КПП, ' +
    'дата регистрации и возраст компании, статус (действует или деятельность прекращена), руководитель, регион, ' +
    'отметка о недостоверности сведений и ссылка на официальную выписку PDF. Используйте перед сделкой, для заполнения ' +
    'реквизитов договора или счёта. Номер предварительно проверяется по контрольной сумме. Поиск по названию ФНС ' +
    'для внешних запросов не поддерживает — нужен ИНН или ОГРН. Только чтение, без токена.',
  inputSchema: { id: z.string().regex(/^\d{10}$|^\d{12}$|^\d{13}$|^\d{15}$/).describe('ИНН (10 или 12 цифр) или ОГРН/ОГРНИП (13 или 15 цифр)') },
  annotations: readOnly,
}, safe(async ({ id }) => {
  const v = id.length <= 12 ? src.validateInn(id) : src.validateOgrn(id);
  if (!v.valid) return { id, found: false, checksum_valid: false, reason: v.reason };
  const rows = await src.egrulFind(id);
  if (!rows.length) return { id, found: false, checksum_valid: true, note: 'В ЕГРЮЛ/ЕГРИП не найдено. Для 12-значного ИНН это может быть физлицо без статуса ИП.' };
  const warnings = [];
  for (const r of rows) {
    if (r.status !== 'действует') warnings.push(`${r.name}: деятельность прекращена ${r.closed_at}`);
    if (r.invalid_info) warnings.push(`${r.name}: ${r.invalid_info}`);
    if (r.age_years != null && r.age_years < 1) warnings.push(`${r.name}: зарегистрирована меньше года назад`);
  }
  return { id, found: true, results: rows, warnings };
}));

server.registerTool('validate_requisites', {
  title: 'Проверка ИНН, ОГРН и БИК на корректность',
  description: 'Офлайн-проверка контрольных сумм ИНН (10 и 12 цифр), ОГРН (13) и ОГРНИП (15), а также формата БИК (9 цифр) ' +
    'и расчётного счёта против БИК. Помогает быстро поймать опечатку в реквизитах до запроса в ФНС или отправки платежа. ' +
    'Не обращается к сети; чтобы узнать, существует ли компания, используйте company_check.',
  inputSchema: {
    inn: z.string().optional().describe('ИНН'),
    ogrn: z.string().optional().describe('ОГРН или ОГРНИП'),
    bik: z.string().optional().describe('БИК банка'),
    account: z.string().optional().describe('Расчётный счёт (20 цифр); проверяется вместе с БИК'),
  },
  annotations: local,
}, safe(async ({ inn, ogrn, bik, account }) => {
  const out = {};
  if (inn) out.inn = { value: inn, ...src.validateInn(inn) };
  if (ogrn) out.ogrn = { value: ogrn, ...src.validateOgrn(ogrn) };
  if (bik) out.bik = { value: bik, valid: /^04\d{7}$/.test(bik), reason: /^04\d{7}$/.test(bik) ? undefined : 'БИК российского банка — 9 цифр, начинается с 04' };
  if (account) {
    if (!/^\d{20}$/.test(account)) out.account = { value: account, valid: false, reason: 'Счёт — 20 цифр' };
    else if (!bik || !/^\d{9}$/.test(bik)) out.account = { value: account, valid: null, reason: 'Для проверки счёта нужен БИК' };
    else {
      const d = [...(bik.slice(-3) + account)].map(Number);
      const w = [7, 1, 3];
      const sum = d.reduce((s, x, i) => s + x * w[i % 3], 0);
      out.account = { value: account, valid: sum % 10 === 0, reason: sum % 10 === 0 ? undefined : 'Счёт не соответствует БИК (контрольный ключ)' };
    }
  }
  if (!Object.keys(out).length) throw new Error('Передайте хотя бы один реквизит: inn, ogrn, bik или account');
  return out;
}));

server.registerTool('bank_by_bik', {
  title: 'Банк по БИК',
  description: 'Реквизиты банка по БИК: полное и краткое название, корреспондентский счёт, город, адрес, регистрационный номер ЦБ. ' +
    'Нужен для заполнения платёжек и договоров. Данные справочника bik-info.ru (по базе ЦБ РФ). Только чтение, без токена.',
  inputSchema: { bik: z.string().regex(/^\d{9}$/).describe('БИК — 9 цифр') },
  annotations: readOnly,
}, safe(({ bik }) => src.bankByBik(bik)));

// ================= ЦБ РФ =================

server.registerTool('cbr_rates', {
  title: 'Официальные курсы валют ЦБ РФ',
  description: 'Официальные курсы валют Банка России на одну дату. Используйте, когда нужен курс на конкретный день (для счёта, ' +
    'проводки, отчёта); динамику за период даёт cbr_rate_history, пересчёт суммы — currency_convert. ' +
    'Возвращает date (на какую дату ЦБ установил курс — в выходные это последний рабочий день) и rates: code, name, nominal, ' +
    'value_rub (за номинал) и per_unit_rub (за 1 единицу — используйте его для расчётов); missing — запрошенные коды, которых нет у ЦБ. ' +
    'Без codes вернёт все ~50 валют, поэтому лучше передавать нужные коды. Источник cbr.ru, без токена, ответы кэшируются на час; ' +
    'только чтение.',
  inputSchema: {
    date: DateStr.optional().describe('Дата курса ГГГГ-ММ-ДД; по умолчанию сегодня'),
    codes: z.array(z.string().length(3)).optional().describe('Коды валют ISO, например ["USD","EUR","CNY"]'),
  },
  annotations: readOnly,
}, safe(async ({ date, codes }) => {
  const r = await src.cbrRates(date);
  const want = codes?.map(c => c.toUpperCase());
  const rates = want ? r.rates.filter(x => want.includes(x.code)) : r.rates;
  return { date: r.date, rates: rates.map(({ id, ...x }) => x), missing: want?.filter(c => !rates.some(x => x.code === c)) };
}));

server.registerTool('cbr_rate_history', {
  title: 'Динамика курса валюты ЦБ РФ',
  description: 'Как менялся официальный курс одной валюты ЦБ РФ за период: по дням (points: date, per_unit_rub) и сводка — ' +
    'first_rub, last_rub, min_rub, max_rub, change_pct. Используйте для вопросов «как вырос доллар за месяц», графиков и выбора даты ' +
    'конвертации; курс на одну дату — cbr_rates, пересчёт суммы — currency_convert. Без from/to берутся последние 30 дней; ' +
    'ЦБ публикует курс только по рабочим дням, поэтому точек меньше, чем дней. Неизвестный код валюты вернёт ошибку со списком доступных. ' +
    'Источник cbr.ru, без токена, кэш на час; только чтение.',
  inputSchema: {
    code: z.string().length(3).describe('Код валюты ISO, например USD'),
    from: DateStr.optional().describe('Начало периода, ГГГГ-ММ-ДД (по умолчанию 30 дней назад)'),
    to: DateStr.optional().describe('Конец периода, ГГГГ-ММ-ДД (по умолчанию сегодня)'),
  },
  annotations: readOnly,
}, safe(async ({ code, from = daysAgo(30), to = today() }) => {
  const h = await src.cbrRateHistory(code, from, to);
  if (!h.points.length) return { ...h, note: 'За период курсов нет' };
  const v = h.points.map(p => p.per_unit_rub);
  const first = v[0], last = v[v.length - 1];
  return {
    code: h.code, name: h.name, from: h.points[0].date, to: h.points[h.points.length - 1].date,
    first_rub: first, last_rub: last, min_rub: Math.min(...v), max_rub: Math.max(...v),
    change_pct: round((last / first - 1) * 100, 2), points: h.points,
  };
}));

server.registerTool('currency_convert', {
  title: 'Пересчёт суммы по курсу ЦБ',
  description: 'Пересчитывает сумму по официальному курсу ЦБ РФ на дату: рубли ↔ валюта или валюта ↔ валюта (кросс-курс через рубль). ' +
    'Используйте для счетов, инвойсов, актов и отчётов, где нужен именно курс ЦБ; сам курс без суммы — cbr_rates, динамика — cbr_rate_history. ' +
    'Возвращает rate (сколько единиц to за 1 from), result (округлено до копеек) и rate_date — дату, на которую ЦБ установил курс ' +
    '(для выходных это предыдущий рабочий день). Без date — курс на сегодня. Коммерческие курсы банков не учитываются. ' +
    'Источник cbr.ru, без токена; только чтение.',
  inputSchema: {
    amount: z.number().describe('Сумма'),
    from: z.string().length(3).describe('Исходная валюта (RUB, USD, EUR, CNY…)'),
    to: z.string().length(3).describe('Целевая валюта'),
    date: DateStr.optional().describe('Дата курса ГГГГ-ММ-ДД; по умолчанию сегодня'),
  },
  annotations: readOnly,
}, safe(async ({ amount, from, to, date }) => {
  const r = await src.cbrRates(date);
  const rub = c => {
    c = c.toUpperCase();
    if (c === 'RUB') return 1;
    const x = r.rates.find(v => v.code === c);
    if (!x) throw new Error(`Валюта ${c} не найдена в курсах ЦБ`);
    return x.per_unit_rub;
  };
  const rate = rub(from) / rub(to);
  return { amount, from: from.toUpperCase(), to: to.toUpperCase(), rate: round(rate, 6), result: round(amount * rate, 2), rate_date: r.date };
}));

server.registerTool('cbr_key_rate', {
  title: 'Ключевая ставка ЦБ РФ',
  description: 'Ключевая ставка Банка России: current_pct (текущая), as_of, since (с какой даты действует) и changes — только даты, ' +
    'когда ставка менялась, за период (по умолчанию последние 2 года). Используйте для вопросов о ставке и её динамике; ' +
    'чтобы посчитать пени или проценты за просрочку, вызывайте сразу late_payment_penalty — он сам учитывает все изменения ставки. ' +
    'Источник — таблица ключевой ставки на cbr.ru, без токена, кэш на час; только чтение.',
  inputSchema: {
    from: DateStr.optional().describe('Начало периода (по умолчанию 2 года назад)'),
    to: DateStr.optional().describe('Конец периода (по умолчанию сегодня)'),
  },
  annotations: readOnly,
}, safe(async ({ from = daysAgo(730), to = today() }) => {
  const pts = await src.cbrKeyRate(from, to);
  if (!pts.length) return { note: 'За период данных нет' };
  const changes = pts.filter((p, i) => i === 0 || p.rate_pct !== pts[i - 1].rate_pct);
  const cur = pts[pts.length - 1];
  return { current_pct: cur.rate_pct, as_of: cur.date, since: changes[changes.length - 1].date, changes };
}));

server.registerTool('late_payment_penalty', {
  title: 'Пени и проценты за просрочку',
  description: 'Считает неустойку за просрочку оплаты по ключевой ставке ЦБ с учётом всех её изменений за период: ' +
    'проценты по ст. 395 ГК РФ (ставка/365 или 366 в день) или пени по доле ставки (например 1/300 для коммунальных и налоговых ' +
    'пеней физлиц, 1/150 для организаций после 30 дней). Даёт итог и разбивку по периодам ставки. Не заменяет юриста.',
  inputSchema: {
    amount: z.number().positive().describe('Сумма долга в рублях'),
    from: DateStr.describe('Первый день просрочки'),
    to: DateStr.optional().describe('Дата оплаты или расчёта включительно (по умолчанию сегодня)'),
    method: z.enum(['art395', 'fraction']).default('art395').describe('art395 — проценты по ст. 395 ГК; fraction — доля ставки в день'),
    fraction: z.number().int().positive().optional().describe('Знаменатель доли для method=fraction, например 300 или 150'),
  },
  annotations: readOnly,
}, safe(async ({ amount, from, to = today(), method, fraction }) => {
  if (method === 'fraction' && !fraction) throw new Error('Для method=fraction укажите fraction, например 300');
  const pts = await src.cbrKeyRate(src.iso(new Date(Date.parse(from) - 400 * 864e5)), to);
  if (!pts.length) throw new Error('Нет данных о ключевой ставке');
  const rateOn = d => { let r = pts[0].rate_pct; for (const p of pts) { if (p.date <= d) r = p.rate_pct; else break; } return r; };
  const periods = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) {
    const d = src.iso(new Date(t));
    const y = new Date(t).getUTCFullYear();
    const rate = rateOn(d);
    const perDay = method === 'art395' ? amount * rate / 100 / ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365)
      : amount * rate / 100 / fraction;
    const last = periods[periods.length - 1];
    if (last && last.rate_pct === rate) { last.to = d; last.days++; last.sum += perDay; }
    else periods.push({ from: d, to: d, days: 1, rate_pct: rate, sum: perDay });
  }
  const total = periods.reduce((s, p) => s + p.sum, 0);
  return {
    amount, method: method === 'art395' ? 'ст. 395 ГК РФ' : `1/${fraction} ключевой ставки в день`,
    days: periods.reduce((s, p) => s + p.days, 0), total_rub: round(total, 2),
    periods: periods.map(p => ({ ...p, sum: round(p.sum, 2) })),
  };
}));

// ================= Производственный календарь =================

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

server.registerTool('work_calendar', {
  title: 'Производственный календарь РФ',
  description: 'Производственный календарь РФ (федеральный, с переносами по постановлению Правительства) на месяц или год. ' +
    'С month — сводка месяца: work_days, days_off, hours_40h_week (норма часов при 40-часовой неделе с учётом сокращённых дней), ' +
    'short_days, holidays_on_weekdays (праздники в будни), working_weekends (рабочие субботы). Без month — итоги года и таблица по 12 месяцам. ' +
    'Используйте для нормы часов, зарплаты, отпускных и графиков; чтобы прибавить N рабочих дней к дате или посчитать рабочие дни ' +
    'между датами — work_days_calc. Календарь следующего года появляется после постановления о переносах (обычно осенью); ' +
    'если его ещё нет, вернётся ошибка. Источник isdayoff.ru, без токена, кэш на сутки; только чтение.',
  inputSchema: {
    year: z.number().int().min(2013).max(2030).describe('Год'),
    month: z.number().int().min(1).max(12).optional().describe('Месяц 1–12; без него — весь год по месяцам'),
  },
  annotations: readOnly,
}, safe(async ({ year, month }) => {
  const days = await src.yearCalendar(year);
  const stat = list => {
    const work = list.filter(d => d.code !== 1);
    const short = list.filter(d => d.code === 2);
    return {
      calendar_days: list.length, work_days: work.length, days_off: list.length - work.length,
      short_days: short.map(d => d.date), hours_40h_week: work.length * 8 - short.length,
      holidays_on_weekdays: list.filter(d => d.code === 1 && d.weekday >= 1 && d.weekday <= 5).map(d => d.date),
      working_weekends: list.filter(d => d.code !== 1 && (d.weekday === 0 || d.weekday === 6)).map(d => d.date),
    };
  };
  const byMonth = m => days.filter(d => Number(d.date.slice(5, 7)) === m);
  if (month) return { year, month, name: MONTHS[month - 1], ...stat(byMonth(month)) };
  const total = stat(days);
  return {
    year, calendar_days: total.calendar_days, work_days: total.work_days, days_off: total.days_off, hours_40h_week: total.hours_40h_week,
    months: MONTHS.map((name, i) => { const s = stat(byMonth(i + 1)); return { month: i + 1, name, work_days: s.work_days, days_off: s.days_off, hours_40h_week: s.hours_40h_week }; }),
    holidays_on_weekdays: total.holidays_on_weekdays, working_weekends: total.working_weekends, short_days: total.short_days,
  };
}));

server.registerTool('work_days_calc', {
  title: 'Расчёт сроков в рабочих днях',
  description: 'Две операции по производственному календарю РФ: add — к дате прибавить N рабочих дней (срок оплаты, поставки, ' +
    'ответа на претензию; отрицательное N — назад); between — сколько рабочих дней между двумя датами включительно. ' +
    'Учитывает праздники и переносы; календарь на следующий год появляется после постановления Правительства о переносах. Только чтение, без токена.',
  inputSchema: {
    operation: z.enum(['add', 'between']).describe('add — прибавить рабочие дни к дате; between — посчитать рабочие дни между датами'),
    date: DateStr.describe('Начальная дата'),
    days: z.number().int().min(-1000).max(1000).optional().describe('Для add: сколько рабочих дней прибавить (начальный день не считается)'),
    to: DateStr.optional().describe('Для between: конечная дата'),
  },
  annotations: readOnly,
}, safe(async ({ operation, date, days, to }) => {
  const years = new Map();
  const isWork = async d => {
    const y = Number(d.slice(0, 4));
    if (!years.has(y)) years.set(y, new Map((await src.yearCalendar(y)).map(x => [x.date, x.code])));
    return years.get(y).get(d) !== 1;
  };
  const shift = (d, n) => src.iso(new Date(Date.parse(d) + n * 864e5));
  if (operation === 'add') {
    if (days == null) throw new Error('Для add укажите days');
    let d = date, left = Math.abs(days);
    const step = days >= 0 ? 1 : -1;
    while (left > 0) { d = shift(d, step); if (await isWork(d)) left--; }
    return { start: date, work_days: days, result: d, result_is_after_calendar_days: Math.round((Date.parse(d) - Date.parse(date)) / 864e5) };
  }
  if (!to) throw new Error('Для between укажите to');
  const [a, b] = date <= to ? [date, to] : [to, date];
  let work = 0, total = 0;
  for (let d = a; d <= b; d = shift(d, 1)) { total++; if (await isWork(d)) work++; }
  return { from: a, to: b, calendar_days: total, work_days: work, days_off: total - work };
}));

return server;
}
