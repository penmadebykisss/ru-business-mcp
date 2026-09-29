// Открытые источники без токена: ЕГРЮЛ/ЕГРИП (ФНС), ЦБ РФ, производственный календарь, справочник БИК.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url, { method = 'GET', body, headers = {}, as = 'json', encoding = 'utf-8', timeout = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method, body, headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) });
      const text = new TextDecoder(encoding).decode(await res.arrayBuffer());
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} для ${new URL(url).host}: ${text.slice(0, 200)}`);
        e.status = res.status;
        throw e;
      }
      return as === 'json' ? JSON.parse(text) : text;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500 && e.status !== 429) break;
      if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Кэш с временем жизни — повторные вопросы агента не бьют по источникам.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + ttlMs });
  return value;
}

// ---------- Даты ----------
export const iso = d => d.toISOString().slice(0, 10);
export const ruDate = s => s.split('-').reverse().join('.');            // 2026-09-29 -> 29.09.2026
export const fromRu = s => s.split('.').reverse().join('-');            // 29.09.2026 -> 2026-09-29
const num = s => Number(String(s).replace(/\s/g, '').replace(',', '.'));

// ---------- ИНН / ОГРН ----------
function checksum(digits, weights) {
  return weights.reduce((s, w, i) => s + w * digits[i], 0) % 11 % 10;
}

export function validateInn(inn) {
  if (!/^\d{10}$|^\d{12}$/.test(inn)) return { valid: false, reason: 'ИНН состоит из 10 (организация) или 12 (ИП, физлицо) цифр' };
  const d = [...inn].map(Number);
  if (d.length === 10) {
    const ok = checksum(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
    return { valid: ok, type: 'организация', reason: ok ? undefined : 'Не сходится контрольная цифра' };
  }
  const ok = checksum(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && checksum(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  return { valid: ok, type: 'ИП или физлицо', reason: ok ? undefined : 'Не сходятся контрольные цифры' };
}

export function validateOgrn(ogrn) {
  if (/^\d{13}$/.test(ogrn)) {
    const ok = Number(BigInt(ogrn.slice(0, 12)) % 11n % 10n) === Number(ogrn[12]);
    return { valid: ok, type: 'ОГРН организации', reason: ok ? undefined : 'Не сходится контрольная цифра' };
  }
  if (/^\d{15}$/.test(ogrn)) {
    const ok = Number(BigInt(ogrn.slice(0, 14)) % 13n % 10n) === Number(ogrn[14]);
    return { valid: ok, type: 'ОГРНИП', reason: ok ? undefined : 'Не сходится контрольная цифра' };
  }
  return { valid: false, reason: 'ОГРН — 13 цифр, ОГРНИП — 15 цифр' };
}

// ---------- ЕГРЮЛ / ЕГРИП ----------
export async function egrulFind(query) {
  return cached('egrul:' + query, 3600e3, async () => {
    const start = await get('https://egrul.nalog.ru/', {
      method: 'POST', body: new URLSearchParams({ query }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (start.captchaRequired) throw new Error('ФНС запросила капчу — повторите запрос позже');
    if (!start.t) throw new Error('ФНС не приняла запрос: ' + JSON.stringify(start).slice(0, 200));
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 700));
      const res = await get(`https://egrul.nalog.ru/search-result/${start.t}`);
      if (res.rows) return res.rows.map(summarizeEgrul);
    }
    throw new Error('ФНС не вернула результат вовремя');
  });
}

function summarizeEgrul(r) {
  const isIp = r.k === 'fl';
  const registered = r.r ? fromRu(r.r) : null;
  const closed = r.e ? fromRu(r.e) : null;
  const director = r.g ? r.g.split(':') : null;
  return {
    type: isIp ? 'ИП' : 'организация',
    name: r.n, short_name: r.c || undefined,
    inn: r.i, ogrn: r.o, kpp: r.p || undefined,
    registered,
    age_years: registered ? Math.floor((Date.now() - Date.parse(registered)) / (365.25 * 864e5) * 10) / 10 : null,
    status: closed ? 'деятельность прекращена' : 'действует',
    closed_at: closed || undefined,
    director_position: director && director.length > 1 ? director[0].trim() : undefined,
    director: director ? director[director.length - 1].trim() : undefined,
    region: r.rn,
    invalid_info: r.v ? 'в ЕГРЮЛ есть отметка о недостоверности сведений' : undefined,
    extract_pdf: r.t ? `https://egrul.nalog.ru/vyp-download/${r.t}` : undefined,
  };
}

// ---------- ЦБ РФ ----------
function parseValutes(xml) {
  return [...xml.matchAll(/<Valute ID="([^"]+)">([\s\S]*?)<\/Valute>/g)].map(([, id, body]) => {
    const f = tag => (body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1];
    const nominal = num(f('Nominal'));
    const value = num(f('Value'));
    return { id, code: f('CharCode'), name: f('Name'), nominal, value_rub: value, per_unit_rub: Math.round(value / nominal * 1e6) / 1e6 };
  });
}

export async function cbrRates(date) {
  const url = 'https://www.cbr.ru/scripts/XML_daily.asp' + (date ? `?date_req=${ruDate(date)}` : '');
  return cached(url, 3600e3, async () => {
    const xml = await get(url, { as: 'text', encoding: 'windows-1251' });
    const d = (xml.match(/ValCurs Date="([^"]+)"/) || [])[1];
    return { date: d ? fromRu(d) : null, rates: parseValutes(xml) };
  });
}

export async function cbrRateHistory(code, from, to) {
  const { rates } = await cbrRates();
  const cur = rates.find(r => r.code === code.toUpperCase());
  if (!cur) throw new Error(`Валюта ${code} не найдена. Доступны: ${rates.map(r => r.code).join(', ')}`);
  const url = `https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=${ruDate(from)}&date_req2=${ruDate(to)}&VAL_NM_RQ=${cur.id}`;
  const xml = await cached(url, 3600e3, () => get(url, { as: 'text', encoding: 'windows-1251' }));
  const points = [...xml.matchAll(/<Record Date="([^"]+)"[^>]*>([\s\S]*?)<\/Record>/g)].map(([, d, body]) => {
    const nominal = num((body.match(/<Nominal>([^<]*)/) || [])[1]);
    const value = num((body.match(/<Value>([^<]*)/) || [])[1]);
    return { date: fromRu(d), per_unit_rub: Math.round(value / nominal * 1e6) / 1e6 };
  });
  return { code: cur.code, name: cur.name, points };
}

export async function cbrKeyRate(from, to) {
  const url = `https://www.cbr.ru/hd_base/KeyRate/?UniDbQuery.Posted=True&UniDbQuery.From=${ruDate(from)}&UniDbQuery.To=${ruDate(to)}`;
  const html = await cached(url, 3600e3, () => get(url, { as: 'text' }));
  const cells = [...html.matchAll(/<td>([^<]*)<\/td>/g)].map(m => m[1].trim());
  const points = [];
  for (let i = 0; i + 1 < cells.length; i += 2) {
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(cells[i])) points.push({ date: fromRu(cells[i]), rate_pct: num(cells[i + 1]) });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Производственный календарь (isdayoff.ru, данные по постановлениям Правительства РФ) ----------
export async function yearCalendar(year) {
  const url = `https://isdayoff.ru/api/getdata?year=${year}&pre=1`;
  const s = await cached(url, 24 * 3600e3, () => get(url, { as: 'text' }));
  if (!/^[0-4]+$/.test(s.trim())) throw new Error('Календарь на этот год недоступен: ' + s.slice(0, 100));
  // 0 — рабочий, 1 — выходной, 2 — сокращённый предпраздничный, 4 — рабочий (для некоторых регионов)
  return [...s.trim()].map((c, i) => {
    const d = new Date(Date.UTC(year, 0, 1 + i));
    return { date: iso(d), weekday: d.getUTCDay(), code: Number(c) };
  });
}

// ---------- Банки по БИК ----------
export async function bankByBik(bik) {
  const url = `https://bik-info.ru/api.html?type=json&bik=${bik}`;
  const b = await cached(url, 24 * 3600e3, () => get(url));
  if (!b || b.error || !b.name) throw new Error(`Банк с БИК ${bik} не найден`);
  return {
    bik: b.bik, name: b.name, short_name: b.namemini, correspondent_account: b.ks || null,
    city: b.city, address: [b.index, b.city, b.address].filter(Boolean).join(', '),
    registration_number: b.regnum || undefined, phone: b.phone || undefined,
    added: b.dateadd || undefined, changed: b.datechange || undefined,
  };
}
