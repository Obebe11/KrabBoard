'use strict';

const puppeteer = require('puppeteer');
const axios     = require('axios');
const FormData  = require('form-data');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const DIR              = __dirname;
const MOSCOW_TZ        = 'Europe/Moscow'; // UTC+3, без перехода на летнее время с 2014 г.
const TASKS_MD_DEFAULT = '/root/.openclaw/workspace/TASKS.md';

// ─────────────────────────────────────────────
// Moscow time helpers
// ─────────────────────────────────────────────

/**
 * Возвращает Date, чьи UTC-поля соответствуют московскому локальному времени.
 * Используется для getUTCHours() / getUTCDate() без двойной конвертации.
 * Москва = UTC+3, DST не применяется с 2014 г.
 */
function moscowNow() {
  return new Date(Date.now() + 3 * 3600 * 1000);
}

/** Сколько мс до следующего hour:00 по московскому времени. */
function msUntilMoscowHour(targetHour) {
  const nowUtcMs = Date.now();
  // Переводим текущий момент в "московские UTC-поля"
  const msk = new Date(nowUtcMs + 3 * 3600 * 1000);
  // Следующее срабатывание в тех же "московских UTC-полях"
  const next = new Date(msk.getTime());
  next.setUTCHours(targetHour, 0, 0, 0);
  if (next.getTime() <= msk.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  // Возвращаем в реальные UTC миллисекунды
  return (next.getTime() - 3 * 3600 * 1000) - nowUtcMs;
}

// ─────────────────────────────────────────────
// Weather
// ─────────────────────────────────────────────

const WEATHER_LABEL = {
  113: 'SUN',
  116: 'PCLOUD',
  119: 'CLOUD',  122: 'CLOUD',
  143: 'FOG',    248: 'FOG',   260: 'FOG',
  200: 'STORM',
  227: 'SNOW',   230: 'SNOW',
  263: 'DRIZ',   266: 'DRIZ',
  281: 'SLEET',  284: 'SLEET',
  293: 'DRIZ',   296: 'DRIZ',
  299: 'RAIN',   302: 'RAIN',  305: 'RAIN',  308: 'RAIN',
  311: 'SLEET',  314: 'SLEET', 317: 'SLEET', 320: 'SLEET',
  323: 'SNOW',   326: 'SNOW',  329: 'SNOW',  332: 'SNOW',  335: 'SNOW',  338: 'SNOW',
  350: 'RAIN',   353: 'RAIN',  356: 'RAIN',  359: 'RAIN',
  362: 'SLEET',  365: 'SLEET', 374: 'SLEET', 377: 'SLEET',
  386: 'STORM',  389: 'STORM', 392: 'STORM', 395: 'STORM',
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
      temp:  c.temp_C,
      feels: c.FeelsLikeC,
      desc:  c.weatherDesc[0].value,
      hum:   c.humidity,
      wind:  c.windspeedKmph,
      label: WEATHER_LABEL[code] || 'N/A',
      city,
    };
  } catch (err) {
    console.warn('Weather fetch failed:', err.message);
    return { temp: '—', feels: '—', desc: 'No data', hum: '—', wind: '—', label: 'N/A', city };
  }
}

// ─────────────────────────────────────────────
// Theme (Moscow time)
// ─────────────────────────────────────────────

function getTheme() {
  const h = moscowNow().getUTCHours(); // московский час через UTC-поля
  return (h >= 6 && h < 20) ? 'light' : 'dark';
}

// ─────────────────────────────────────────────
// TASKS.md sync
// ─────────────────────────────────────────────

/**
 * Парсит Markdown-таблицу задач.
 *
 * Ожидаемый формат таблицы:
 *   | Задача                 | Прогресс | Дедлайн    | Приоритет | Статус      |
 *   |------------------------|----------|------------|-----------|-------------|
 *   | Написать документацию  | 30       | 2026-04-30 | low       | in_progress |
 *   | [x] Код-ревью          | 100      | 2026-04-14 | medium    | done        |
 *
 * Правила:
 *   - Строки вида [x] в названии → задача выполнена
 *   - Прогресс 100 или статус done → задача выполнена
 *   - Статус можно опустить; тогда он выводится из прогресса:
 *       0 → todo, 1–99 → in_progress
 *   - Дедлайн в формате YYYY-MM-DD (необязателен)
 *   - Приоритет: high / medium / low (необязателен, по умолчанию medium)
 */
function parseTasks(md) {
  const tasks = [];
  let   id    = 1;

  // Ключевые слова, по которым опознаётся строка-заголовок таблицы.
  // Проверяем ВСЕ ячейки строки, а не только первую.
  const HEADER_WORDS = new Set([
    'задача', 'task', 'title', 'название',
    'статус', 'status',
    'прогресс', 'progress',
    'дедлайн', 'deadline',
    'приоритет', 'priority',
  ]);

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim();

    // Только строки таблицы: начинаются и заканчиваются на |
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    // Пропускаем разделитель |---|---|
    if (/^\|[\s\-:|]+\|$/.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;

    const [col0, col1 = '', col2 = '', col3 = '', col4 = ''] = cells;

    // Пропускаем строку-заголовок: достаточно одного совпадения в любой ячейке
    if (cells.some(c => HEADER_WORDS.has(c.toLowerCase()))) continue;

    // Пустой заголовок задачи — пропускаем
    if (!col0) continue;

    // Guard: колонка «Прогресс» должна быть числом (или пустой)
    // Если там текст — это нераспознанный заголовок или мусор
    const rawProg = col1.replace('%', '').trim();
    if (rawProg !== '' && !/^\d+$/.test(rawProg)) continue;

    // Маркер [x] в названии → задача завершена
    const isDoneMarker = /^\[x\]/i.test(col0);
    const title        = col0.replace(/^\[x\]\s*/i, '').trim();
    if (!title) continue;

    // Прогресс
    const progress = Math.min(100, Math.max(0, parseInt(col1.replace('%', ''), 10) || 0));

    // Дедлайн: только если похоже на YYYY-MM-DD
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(col2.trim()) ? col2.trim() : null;

    // Приоритет
    const priority = ['high', 'medium', 'low'].includes(col3.toLowerCase())
      ? col3.toLowerCase() : 'medium';

    // Статус
    let status;
    if (isDoneMarker || progress >= 100) {
      status = 'done';
    } else if (['todo', 'in_progress', 'done'].includes(col4.toLowerCase())) {
      status = col4.toLowerCase();
    } else {
      status = progress > 0 ? 'in_progress' : 'todo';
    }

    const task = { id: id++, title, progress, priority, status };
    if (deadline) task.deadline = deadline;
    tasks.push(task);
  }

  return tasks;
}

/**
 * Читает TASKS.md, парсит задачи, фильтрует завершённые
 * и сохраняет результат в tasks.json.
 * Возвращает true при успехе, false если файл не найден.
 */
function syncFromTasksMd(mdPath, jsonPath) {
  if (!fs.existsSync(mdPath)) {
    console.log(`ℹ️  TASKS.md не найден: ${mdPath}`);
    console.log('   Используем tasks.json напрямую.');
    return false;
  }

  console.log(`📖 Читаем TASKS.md: ${mdPath}`);
  const md       = fs.readFileSync(mdPath, 'utf8');
  const allTasks = parseTasks(md);

  if (!allTasks.length) {
    console.warn('⚠️  В TASKS.md не найдено ни одной задачи. Проверь формат таблицы.');
    return false;
  }

  // Фильтруем выполненные
  const active  = allTasks.filter(t => t.status !== 'done' && t.progress < 100);
  const hidden  = allTasks.length - active.length;

  console.log(`   Всего: ${allTasks.length} | Активных: ${active.length} | Скрыто завершённых: ${hidden}`);

  fs.writeFileSync(jsonPath, JSON.stringify({ tasks: active }, null, 2), 'utf8');
  console.log('✅ tasks.json обновлён из TASKS.md');
  return true;
}

// ─────────────────────────────────────────────
// System info
// ─────────────────────────────────────────────

function meterBar(pct, color) {
  return `
    <div class="meter-track">
      <div class="meter-fill" style="width:${pct}%;background:${color}"></div>
    </div>`;
}

function sysItem(icon, label, value, sub = '', meterPct = null, meterColor = '#22c55e') {
  const meter = meterPct !== null ? meterBar(meterPct, meterColor) : '';
  return `
  <div class="sys-item">
    <div class="sys-icon">${icon}</div>
    <div class="sys-text" style="flex:1;min-width:0">
      <div class="sys-label">${label}</div>
      <div class="sys-value">${value}</div>
      ${sub ? `<div class="sys-sub">${sub}</div>` : ''}
      ${meter}
    </div>
  </div>`;
}

function buildSysItems(config) {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const memPct   = Math.round((usedMem / totalMem) * 100);
  const toGB     = b => (b / 1024 ** 3).toFixed(1);
  const memColor = memPct > 85 ? '#ef4444' : memPct > 65 ? '#f59e0b' : '#22c55e';

  const cpus     = os.cpus();
  const cpuCount = cpus.length;
  const loadAvg  = os.loadavg()[0];
  const cpuPct   = Math.min(100, Math.round((loadAvg / cpuCount) * 100));
  const cpuColor = cpuPct > 80 ? '#ef4444' : cpuPct > 50 ? '#f59e0b' : '#3b82f6';

  const uptimeSec  = os.uptime();
  const uptimeDays = Math.floor(uptimeSec / 86400);
  const uptimeHrs  = Math.floor((uptimeSec % 86400) / 3600);
  const uptimeMins = Math.floor((uptimeSec % 3600) / 60);
  const uptimeStr  = uptimeDays > 0
    ? `${uptimeDays}д ${uptimeHrs}ч ${uptimeMins}м`
    : `${uptimeHrs}ч ${uptimeMins}м`;

  return [
    sysItem('AI',   'AI Модель',    config.ai_model || 'не указано', config.ai_provider || ''),
    sysItem('MEM',  'ОЗУ',          `${memPct}%`,                    `${toGB(usedMem)} / ${toGB(totalMem)} GB`, memPct, memColor),
    sysItem('CPU',  'CPU нагрузка', `${cpuPct}%`,                    `${cpuCount} ядер • load ${loadAvg.toFixed(2)}`, cpuPct, cpuColor),
    sysItem('UP',   'Аптайм',       uptimeStr,                       `${os.type()} ${os.arch()}`),
    sysItem('NODE', 'Node.js',      process.version,                 `v8 ${process.versions.v8}`),
    sysItem('HOST', 'Хост',         os.hostname(),                   os.release()),
  ].join('\n');
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
  if (s === 'done')        return { label: 'Готово',       cls: 'badge-done' };
  if (s === 'in_progress') return { label: 'В работе',     cls: 'badge-wip'  };
  return                          { label: 'К выполнению', cls: 'badge-todo' };
}

function daysLeftHtml(deadline) {
  if (!deadline) return '';
  // "Сегодня" в московском времени (en-CA → формат YYYY-MM-DD)
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: MOSCOW_TZ });
  const today    = new Date(todayStr + 'T00:00:00Z');
  const d        = new Date(deadline + 'T00:00:00Z');
  const diff     = Math.round((d - today) / 86400000);
  let color, label;
  if (diff < 0)        { color = '#ef4444'; label = `Просрочено на ${Math.abs(diff)} дн.`; }
  else if (diff === 0) { color = '#f59e0b'; label = 'Сегодня дедлайн!'; }
  else if (diff <= 3)  { color = '#f59e0b'; label = `${diff} дн. до дедлайна`; }
  else                 { color = '#334155'; label = `Дедлайн: ${deadline}`; }
  return `<span class="task-deadline" style="color:${color}">${label}</span>`;
}

function buildTaskCards(tasks) {
  if (!tasks.length) return '<div class="empty">Задачи не найдены. Добавь их в TASKS.md или tasks.json</div>';

  return tasks.map(t => {
    const color = priorityColor(t.priority);
    const badge = statusBadge(t.status);
    const pct   = Math.min(100, Math.max(0, t.progress || 0));
    const dl    = daysLeftHtml(t.deadline);

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
  // Дата и время всегда в московском часовом поясе
  const now     = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', {
    timeZone: MOSCOW_TZ,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('ru-RU', {
    timeZone: MOSCOW_TZ,
    hour: '2-digit', minute: '2-digit',
  });

  const done = tasks.filter(t => t.status === 'done').length;
  const wip  = tasks.filter(t => t.status === 'in_progress').length;
  const todo = tasks.filter(t => t.status === 'todo').length;
  const pct  = tasks.length
    ? Math.round(tasks.reduce((a, t) => a + (t.progress || 0), 0) / tasks.length)
    : 0;

  const theme      = getTheme(); // использует московское время внутри
  const themeClass = `theme-${theme}`;
  const themeLabel = theme === 'light' ? 'DAY' : 'NIGHT';
  const themeBadge = theme === 'light' ? 'theme-badge-light' : 'theme-badge-dark';

  const template = fs.readFileSync(path.join(DIR, 'dashboard.html'), 'utf8');

  return template
    .replace('{{THEME_CLASS}}',       themeClass)
    .replace('{{THEME_LABEL}}',       themeLabel)
    .replace('{{THEME_BADGE_CLASS}}', themeBadge)
    .replace('{{TITLE}}',             config.dashboard_title || 'Мой дашборд')
    .replace('{{DATE}}',              dateStr)
    .replace(/{{TIME}}/g,             timeStr)
    .replace('{{W_EMOJI}}',           weather.label)
    .replace('{{W_TEMP}}',            weather.temp)
    .replace('{{W_DESC}}',            weather.desc)
    .replace('{{W_HUM}}',             weather.hum)
    .replace('{{W_WIND}}',            weather.wind)
    .replace('{{W_FEELS}}',           weather.feels)
    .replace('{{W_CITY}}',            weather.city)
    .replace('{{S_DONE}}',            String(done))
    .replace('{{S_WIP}}',             String(wip))
    .replace('{{S_TODO}}',            String(todo))
    .replace('{{S_PCT}}',             String(pct))
    .replace('{{TASK_COUNT}}',        String(tasks.length))
    .replace('{{TASK_CARDS}}',        buildTaskCards(tasks))
    .replace('{{SYS_ITEMS}}',         buildSysItems(config));
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

  // Авто-высота: растягиваем вьюпорт под реальный контент
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
      `Ошибка: файл не найден — ${filename}\n` +
      `Убедись, что файл ${filePath} существует и заполнен.`,
    );
  }
  return filePath;
}

async function main() {
  console.log('🚀 KrabBoard: генерация дашборда...');

  requireFile('config.json');
  requireFile('dashboard.html');

  const config        = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
  const tasksMdPath   = config.tasks_md_path || TASKS_MD_DEFAULT;
  const tasksJsonPath = path.join(DIR, 'tasks.json');

  // Синхронизация из TASKS.md (если есть), иначе используем tasks.json
  const synced = syncFromTasksMd(tasksMdPath, tasksJsonPath);
  if (!synced) requireFile('tasks.json');

  const tasksData = JSON.parse(fs.readFileSync(tasksJsonPath, 'utf8'));
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

  if (config.BOT_TOKEN && config.CHAT_ID && config.BOT_TOKEN !== 'ВАШ_ТОКЕН_БОТА') {
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
    process.exit(1);
  }
  const config       = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const scheduleHour = config.schedule_hour ?? 8; // в московском времени (МСК)

  console.log(`⏰ Планировщик запущен. Дашборд будет отправляться каждый день в ${scheduleHour}:00 МСК.`);
  console.log('   Совет: для надёжности используй cron (см. README.md).');

  function scheduleNext() {
    const delay      = msUntilMoscowHour(scheduleHour);
    const nextDisplay = new Date(Date.now() + delay)
      .toLocaleString('ru-RU', { timeZone: MOSCOW_TZ });
    const mins = Math.round(delay / 60000);
    console.log(`⏳ Следующая отправка через ${mins} мин. (${nextDisplay} МСК)`);
    setTimeout(() => {
      main()
        .catch(err => console.error('❌', err.message))
        .finally(scheduleNext);
    }, delay);
  }

  scheduleNext();
}
