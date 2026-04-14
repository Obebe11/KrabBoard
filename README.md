# KrabBoard

Скрипт для ежедневного дашборда в Telegram. Каждое утро бот присылает картинку с вашими задачами и погодой.

---

## Что умеет

- Показывает **текущие задачи** с прогресс-барами и дедлайнами
- Показывает **погоду** (Москва или любой другой город) — без API-ключей
- Отправляет картинку прямо в **Telegram** через вашего бота
- Запускается по расписанию или вручную одной командой

---

## Требования

- [Node.js](https://nodejs.org/) версии 18 или выше
- Telegram бот и его токен (получить у [@BotFather](https://t.me/BotFather))

---

## Установка

```bash
# 1. Перейти в папку проекта
cd KrabBoard

# 2. Установить зависимости (один раз)
npm install
```

> `puppeteer` при первой установке скачает браузер Chromium (~170 МБ) — это нормально.

---

## Настройка

### 1. config.json — основные настройки

```json
{
  "BOT_TOKEN":       "123456789:ABC-токен-вашего-бота",
  "CHAT_ID":         "123456789",
  "city":            "Moscow",
  "schedule_hour":   8,
  "dashboard_title": "Мой дашборд"
}
```

| Поле              | Что указывать                                              |
|-------------------|------------------------------------------------------------|
| `BOT_TOKEN`       | Токен от BotFather                                         |
| `CHAT_ID`         | Ваш Telegram ID (узнать: написать `/start` боту @userinfobot) |
| `city`            | Город для погоды (на английском: Moscow, London, Berlin…) |
| `schedule_hour`   | Час отправки (0–23, по умолчанию 8 = 08:00)               |
| `dashboard_title` | Заголовок дашборда                                         |

### 2. tasks.json — ваши задачи

```json
{
  "tasks": [
    {
      "id": 1,
      "title": "Название задачи",
      "progress": 50,
      "priority": "high",
      "deadline": "2026-04-20",
      "status": "in_progress"
    }
  ]
}
```

| Поле       | Значения                                   |
|------------|--------------------------------------------|
| `progress` | 0–100 (процент выполнения)                 |
| `priority` | `high` (красный) / `medium` (жёлтый) / `low` (зелёный) |
| `status`   | `todo` / `in_progress` / `done`            |
| `deadline` | Дата в формате `ГГГГ-ММ-ДД` (необязательно) |

---

## Запуск

### Один раз прямо сейчас

```bash
node generate.js --now
```

Скрипт создаст `dashboard.png` и отправит его в Telegram.

### По расписанию (встроенный планировщик)

```bash
node generate.js
```

Скрипт будет работать в фоне и отправлять дашборд каждый день в `schedule_hour`.

### По расписанию через cron (рекомендуется)

Cron надёжнее — он запускает скрипт даже после перезагрузки сервера.

```bash
# Открыть редактор cron
crontab -e

# Добавить строку (пример: каждый день в 08:00)
0 8 * * * node /полный/путь/до/KrabBoard/generate.js --now >> /полный/путь/до/KrabBoard/krabboard.log 2>&1
```

---

## Интеграция с openclaw

Чтобы openclaw мог вызывать дашборд как скилл, добавь в бота обработчик команды `/dashboard`:

```javascript
// Пример для Telegraf / Grammy
bot.command('dashboard', async (ctx) => {
  const { execFile } = require('child_process');
  execFile('node', ['/путь/до/KrabBoard/generate.js', '--now'], (err) => {
    if (err) ctx.reply('Ошибка генерации дашборда: ' + err.message);
  });
});
```

### Как модуль (для продвинутой интеграции)

Если хочешь вызывать генерацию из кода бота напрямую:

```javascript
// В файле бота
const { main } = require('./KrabBoard/generate');

bot.command('dashboard', async (ctx) => {
  await main();
  // dashboard.png уже отправлен ботом в Telegram
});
```

Для этого добавь в конец `generate.js` строку:
```javascript
module.exports = { main };
```

---

## Структура файлов

```
KrabBoard/
├── generate.js      — главный скрипт
├── dashboard.html   — HTML-шаблон дашборда (стили, вёрстка)
├── config.json      — настройки (токен, город, расписание)
├── tasks.json       — список задач
├── dashboard.png    — последний сгенерированный дашборд
└── package.json     — зависимости Node.js
```

---

## Зависимости

| Пакет      | Для чего                              |
|------------|---------------------------------------|
| puppeteer  | Скриншот HTML через headless Chromium |
| axios      | HTTP-запросы (погода, Telegram API)   |
| form-data  | Отправка фото в Telegram              |

Погода берётся с [wttr.in](https://wttr.in) — бесплатно, без регистрации и API-ключей.
