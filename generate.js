'use strict';

const puppeteer = require('puppeteer');
const axios     = require('axios');
const FormData  = require('form-data');
const fs        = require('fs');
const path      = require('path');

const DIR = __dirname;

// ─────────────────────────────────────────────
// Weather
// ─────────────────────────────────────────────

const WEATHER_EMOJI = {
  113: '☀️',
  116: '⛅',
  119: '☁️',
  122: '☁️',
  143: '🌫️', 248: '🌫️', 260: '🌫️',
  200: '⛈️',
  227: '❄️', 230: '❄️',
  263: '🌦️', 266: '🌦️',
  281: '🌧️', 284: '🌧️',
  293: '🌦️', 296: '🌦️',
  299: '🌧️', 302: '🌧️', 305: '🌧️', 308: '🌧️',
  311: '🌨️', 314: '🌨️', 317: '🌨️', 320: '🌨️',
  323: '❄️', 326: '❄️', 329: '❄️', 332: '❄️', 335: '❄️', 338: '❄️',
  350: '🌧️', 353: '🌧️', 356: '🌧️', 359: '🌧️',
  362: '🌨️', 365: '🌨️', 374: '🌨️', 377: '🌨️',
  386: '⛈️', 389: '⛈️', 392: '⛈️', 395: '⛈️',
};

async function getWeather(city) {
  try {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'curl/7.68.0' },
    });
    const c = res.data.current_condition[0];
    const code = parseInt(c.weatherCode, 10);
    return {
      temp:   c.temp_C,
      feels:  c.FeelsLikeC,
      desc:   c.weatherDesc[0].value,
      hum:    c.humidity,
      wind:   c.windspeedKmph,
      emoji:  WEATHER_EMOJI[code] || '🌡️',
      city,
    };
  } catch (err) {
    console.warn('⚠️  Не удалось получить погоду:', err.message);
    return { temp: '—', feels: '—', desc: 'Нет данных', hum: '—', wind: '—', emoji: '🌡️', city };
  }
}

// ─────────────────────────────────────────────
// Task helpers
// ─────────────────────────────────────────────

function priorityColor(p) {
  if (p === 'high')   return '#ef4444';
  if (p === 'medium') return '#f59e0b';
  return '#22c55e';
}

function statusBadge(s) {
  if (s === 'done')        return { label: 'Готово',      cls: 'badge-done' };
  if (s === 'in_progress') return { label: 'В работе',    cls: 'badge-wip'  };
  return                          { label: 'К выполнению', cls: 'badge-todo' };
}

function daysLeftHtml(deadline) {
  if (!deadline) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const d     = new Date(deadline); d.setHours(0,0,0,0);
  const diff  = Math.round((d - today) / 86400000);
  let color, label;
  if (diff < 0)      { color = '#ef4444'; label = `Просрочено на ${Math.abs(diff)} дн.`; }
  else if (diff === 0) { color = '#f59e0b'; label = 'Сегодня дедлайн!'; }
  else if (diff <= 3)  { color = '#f59e0b'; label = `${diff} дн. до дедлайна`; }
  else                 { color = '#334155'; label = `Дедлайн: ${deadline}`; }
  return `<span class="task-deadline" style="color:${color}">${label}</span>`;
}

function buildTaskCards(tasks) {
  if (!tasks.length) return '<div class="empty">Задачи не найдены. Добавь их в tasks.json</div>';

  return tasks.map(t => {
    const color  = priorityColor(t.priority);
    const badge  = statusBadge(t.status);
    const pct    = Math.min(100, Math.max(0, t.progress || 0));
    const dl     = daysLeftHtml(t.deadline);

    return `
    <div class="task-card">
      <div class="task-accent" style="background:${color}"></div>
      <div class="task-body">
        <div class="task-top">
          <span class="task-title">${t.title}</span>
          <span class="task-badge ${badge.cls}">${badge.label}</span>
        </div>
        <div class="progress-row">
          <div class="progress-track">
            <div class="progress-fill" style="width:${pct}%;background:linear-gradient(90deg, ${color}, ${color}99)"></div>
          </div>
          <span class="progress-pct">${pct}%</span>
        </div>
        ${dl}
      </div>
    </div>`;
  }).join('\n');
}

// ─────────────────────────────────────────────
// HTML rendering
// ─────────────────────────────────────────────

function renderHTML(weather, tasks, config) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const done  = tasks.filter(t => t.status === 'done').length;
  const wip   = tasks.filter(t => t.status === 'in_progress').length;
  const todo  = tasks.filter(t => t.status === 'todo').length;
  const pct   = tasks.length
    ? Math.round(tasks.reduce((a, t) => a + (t.progress || 0), 0) / tasks.length)
    : 0;

  const template = fs.readFileSync(path.join(DIR, 'dashboard.html'), 'utf8');

  return template
    .replace('{{TITLE}}',      config.dashboard_title || 'Мой дашборд')
    .replace('{{DATE}}',       dateStr)
    .replace(/{{TIME}}/g,      timeStr)
    .replace('{{W_EMOJI}}',    weather.emoji)
    .replace('{{W_TEMP}}',     weather.temp)
    .replace('{{W_DESC}}',     weather.desc)
    .replace('{{W_HUM}}',      weather.hum)
    .replace('{{W_WIND}}',     weather.wind)
    .replace('{{W_FEELS}}',    weather.feels)
    .replace('{{W_CITY}}',     weather.city)
    .replace('{{S_DONE}}',     String(done))
    .replace('{{S_WIP}}',      String(wip))
    .replace('{{S_TODO}}',     String(todo))
    .replace('{{S_PCT}}',      String(pct))
    .replace('{{TASK_COUNT}}', String(tasks.length))
    .replace('{{TASK_CARDS}}', buildTaskCards(tasks));
}

// ─────────────────────────────────────────────
// Screenshot with Puppeteer
// ─────────────────────────────────────────────

async function screenshot(html, outPath) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Auto-height: expand viewport to full content height
  const bodyH = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewport({ width: 800, height: bodyH, deviceScaleFactor: 2 });

  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();
}

// ─────────────────────────────────────────────
// Telegram
// ─────────────────────────────────────────────

async function sendToTelegram(token, chatId, imagePath, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo',   fs.createReadStream(imagePath));
  form.append('caption', caption || '📊 Ежедневный дашборд');

  const res = await axios.post(
    `https://api.telegram.org/bot${token}/sendPhoto`,
    form,
    { headers: form.getHeaders(), timeout: 30000 },
  );
  return res.data;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

function requireFile(filename) {
  const filePath = path.join(DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Ошибка: файл конфигурации не найден — ${filename}\n` +
      `Убедись, что файл ${filePath} существует и заполнен.`
    );
  }
  return filePath;
}

async function main() {
  console.log('🚀 KrabBoard: генерация дашборда...');

  requireFile('config.json');
  requireFile('tasks.json');
  requireFile('dashboard.html');

  const config    = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'),  'utf8'));
  const tasksData = JSON.parse(fs.readFileSync(path.join(DIR, 'tasks.json'),   'utf8'));
  const tasks     = tasksData.tasks || [];

  console.log(`📡 Получаем погоду для "${config.city}"...`);
  const weather = await getWeather(config.city || 'Moscow');
  console.log(`   ${weather.emoji} ${weather.temp}°C — ${weather.desc}`);

  console.log('🎨 Рендерим HTML...');
  const html = renderHTML(weather, tasks, config);

  const outPath = path.join(DIR, 'dashboard.png');
  console.log('📸 Делаем скриншот...');
  await screenshot(html, outPath);
  console.log(`✅ Сохранено: ${outPath}`);

  if (config.BOT_TOKEN && config.CHAT_ID &&
      config.BOT_TOKEN !== 'ВАШ_ТОКЕН_БОТА') {
    console.log('📤 Отправляем в Telegram...');
    await sendToTelegram(config.BOT_TOKEN, config.CHAT_ID, outPath);
    console.log('✅ Дашборд отправлен!');
  } else {
    console.log('⚠️  BOT_TOKEN / CHAT_ID не заполнены — отправка пропущена.');
    console.log('   Заполни config.json и запусти снова.');
  }
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--now')) {
  // Одноразовый запуск: node generate.js --now
  main().catch(err => { console.error('❌', err.message); process.exit(1); });

} else {
  // Встроенный планировщик: node generate.js
  const cfgPath = path.join(DIR, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error('❌ Ошибка: файл конфигурации не найден — config.json');
    console.error(`   Создай файл: ${cfgPath}`);
    process.exit(1);
  }
  const config       = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const scheduleHour = config.schedule_hour ?? 8;

  console.log(`⏰ Планировщик запущен. Дашборд будет отправляться каждый день в ${scheduleHour}:00.`);
  console.log('   Совет: для надёжности используй cron (см. README.md).');

  function scheduleNext() {
    const now  = new Date();
    const next = new Date();
    next.setHours(scheduleHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    const mins  = Math.round(delay / 60000);
    console.log(`⏳ Следующая отправка через ${mins} мин. (${next.toLocaleString('ru-RU')})`);
    setTimeout(() => {
      main()
        .catch(err => console.error('❌', err.message))
        .finally(scheduleNext);
    }, delay);
  }

  scheduleNext();
}
