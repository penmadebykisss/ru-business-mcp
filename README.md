# ru-business-mcp — бизнес-данные России для ИИ-агентов

[![penmadebykisss/ru-business-mcp MCP server](https://glama.ai/mcp/servers/penmadebykisss/ru-business-mcp/badges/score.svg)](https://glama.ai/mcp/servers/penmadebykisss/ru-business-mcp)
[![CI](https://github.com/penmadebykisss/ru-business-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/penmadebykisss/ru-business-mcp/actions/workflows/ci.yml)

MCP-сервер, который даёт Claude, Cursor и другим ИИ-ассистентам официальные данные для работы с российским бизнесом —
**без регистрации и токенов**: проверка контрагента по ИНН в ЕГРЮЛ/ЕГРИП ФНС, курсы валют и ключевая ставка ЦБ РФ,
расчёт пеней по ст. 395 ГК, производственный календарь и сроки в рабочих днях, реквизиты банка по БИК.

Спросите ассистента: *«Проверь контрагента 7707083893 — можно ли с ним работать?»*, *«Сколько пеней набежало на долг
250 000 ₽ с 1 марта?»*, *«Пересчитай инвойс на 12 400 юаней по курсу ЦБ на дату отгрузки»*, *«Какой срок оплаты,
если 10 рабочих дней с 28 апреля?»* — и он сам вызовет нужные инструменты.

## Инструменты

| Инструмент | Что делает | Источник |
|---|---|---|
| `company_check` | Организация или ИП по ИНН/ОГРН: название, КПП, дата регистрации и возраст, статус, руководитель, регион, недостоверность, ссылка на выписку PDF | ЕГРЮЛ/ЕГРИП ФНС |
| `validate_requisites` | Контрольные суммы ИНН, ОГРН/ОГРНИП, формат БИК, ключ расчётного счёта (офлайн) | — |
| `bank_by_bik` | Банк по БИК: название, корсчёт, адрес | справочник БИК ЦБ |
| `cbr_rates` | Официальные курсы валют на дату | ЦБ РФ |
| `cbr_rate_history` | Динамика курса за период: минимум, максимум, изменение | ЦБ РФ |
| `currency_convert` | Пересчёт суммы по курсу ЦБ на дату | ЦБ РФ |
| `cbr_key_rate` | Ключевая ставка: текущая и история изменений | ЦБ РФ |
| `late_payment_penalty` | Проценты по ст. 395 ГК или пени 1/300, 1/150 с учётом смены ставки | ЦБ РФ |
| `work_calendar` | Производственный календарь: рабочие дни, праздники, переносы, норма часов | isdayoff.ru |
| `work_days_calc` | Прибавить N рабочих дней к дате или посчитать рабочие дни между датами | isdayoff.ru |

## Установка

Нужен только [Node.js](https://nodejs.org) 18+ — сервер запускается прямо с GitHub через `npx`.

### Claude Desktop

`claude_desktop_config.json` (Настройки → Разработчик → Изменить конфиг):

```json
{
  "mcpServers": {
    "ru-business": {
      "command": "npx",
      "args": ["-y", "github:penmadebykisss/ru-business-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add ru-business -- npx -y github:penmadebykisss/ru-business-mcp
```

### Cursor, Windsurf и другие клиенты

Любой клиент с поддержкой MCP по stdio: команда `npx`, аргументы `-y github:penmadebykisss/ru-business-mcp`.

## Ограничения

- Поиск компаний по названию ФНС для внешних запросов не отдаёт — нужен ИНН или ОГРН.
- При частых запросах ФНС может попросить капчу; сервер кэширует ответы на час.
- Календарь на следующий год появляется после постановления Правительства о переносах выходных.
- Расчёт пеней — справочный и не заменяет юридическую консультацию.

## Смотрите также

[rf-marketplaces-mcp](https://github.com/penmadebykisss/rf-marketplaces-mcp) — аналитика товаров Wildberries для ИИ-агентов.

## English

**ru-business-mcp** gives AI assistants official Russian business data with **no account or API token**: company
lookup by INN/OGRN in the Federal Tax Service registry (EGRUL/EGRIP), Bank of Russia exchange rates and key rate,
late-payment interest (Civil Code art. 395), the Russian production calendar and business-day math, and bank details by BIK.

```bash
npx -y github:penmadebykisss/ru-business-mcp
```

## Лицензия

MIT
