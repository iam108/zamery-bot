# 📋 Замеры — Telegram бот + веб-панель

Система приёма заявок на замер через Telegram Mini App с хранением в PostgreSQL и веб-панелью для просмотра.

## Что умеет

- **Mini App форма** прямо в боте — вместо Google Forms
- **Красивые сообщения** в группу с кнопками смены статуса
- **Веб-панель** с фильтрами, поиском и историей изменений
- **PostgreSQL** база с полным логированием
- **Деплой на Railway** за 10 минут

---

## Структура проекта

```
zamery-bot/
├── src/
│   ├── index.js          # Точка входа
│   ├── bot/
│   │   ├── index.js      # Telegraf бот, команды, обработчики
│   │   └── formatter.js  # Форматирование сообщений в группу
│   ├── db/
│   │   ├── pool.js       # Подключение к PostgreSQL
│   │   ├── migrate.js    # Создание таблиц
│   │   └── queries.js    # Все запросы к БД
│   └── web/
│       └── index.js      # Express: веб-панель + Mini App форма
├── Dockerfile
├── railway.toml
└── .env.example
```

---

## Деплой на Railway — пошагово

### Шаг 1 — Создай бота у @BotFather

1. Открой [@BotFather](https://t.me/BotFather) в Telegram
2. `/newbot` → введи имя и username
3. Скопируй **BOT_TOKEN**
4. Потом вернёшься сюда чтобы добавить Mini App

### Шаг 2 — Создай проект на Railway

1. Зайди на [railway.app](https://railway.app) → **New Project**
2. **Deploy from GitHub repo** → подключи репозиторий с этим кодом
   - Или: **Deploy from template** → пусто, потом `railway up` из CLI

### Шаг 3 — Добавь PostgreSQL

В проекте Railway:
1. Нажми **+ New** → **Database** → **PostgreSQL**
2. Railway автоматически добавит `DATABASE_URL` в переменные окружения

### Шаг 4 — Переменные окружения

В Railway → твой сервис → **Variables** добавь:

| Переменная | Значение |
|---|---|
| `BOT_TOKEN` | токен от @BotFather |
| `GROUP_CHAT_ID` | ID группы (как получить — см. ниже) |
| `WEBAPP_URL` | URL твоего приложения на Railway (см. Settings → Domain) |
| `ADMIN_PASSWORD` | любой пароль для входа в панель |
| `SESSION_SECRET` | любая случайная строка (32+ символа) |
| `NODE_ENV` | `production` |

> `DATABASE_URL` Railway добавит сам при создании PostgreSQL сервиса.

#### Как узнать GROUP_CHAT_ID

1. Добавь бота в группу
2. Напиши любое сообщение в группе
3. Открой: `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`
4. Найди `"chat":{"id":` — это и есть GROUP_CHAT_ID (отрицательное число)

### Шаг 5 — Подключи Mini App к боту

После деплоя, когда у тебя есть URL вида `https://zamery-xxx.railway.app`:

1. В @BotFather → `/newapp` или `/mybots` → выбери бота → **Bot Settings** → **Menu Button**
2. Или: `/setmenubutton` → укажи URL: `https://zamery-xxx.railway.app/form`
3. Название кнопки: `📋 Новая заявка`

### Шаг 6 — Проверка

- Открой бота → нажми `/start` → появится кнопка **📋 Новая заявка**
- Заполни форму → в группе придёт красивое сообщение с кнопками
- Зайди на `https://zamery-xxx.railway.app/admin` → введи пароль → увидишь заявку

---

## Команды бота

| Команда | Что делает |
|---|---|
| `/start` | Показывает кнопку для открытия формы |
| `/stats` | Статистика по заявкам (в любом чате) |
| `/panel` | Ссылка на веб-панель |

## Кнопки в группе

Когда приходит заявка, под сообщением есть кнопки:
- **🔧 Взять в работу** — меняет статус, кнопки обновляются
- **✅ Готово** — закрывает заявку
- **❌ Отменить** — отмена

Всё логируется с именем пользователя кто нажал.

---

## Локальная разработка

```bash
# Установка зависимостей
npm install

# Скопируй и заполни переменные
cp .env.example .env

# Создай таблицы (нужен DATABASE_URL в .env)
npm run migrate

# Запуск (polling режим, без webhook)
npm run dev
```

---

## Веб-панель

URL: `https://your-app.railway.app/admin`

- **Дашборд** — счётчики по статусам
- **Таблица** — все заявки с фильтром по статусу и поиском
- **Детальная страница** — полные данные + смена статуса + история изменений
- **Фильтры**: Все / Новые / В работе / Выполнены / Отменены
- **Поиск**: по адресу, имени, контактам

---

## База данных

### Таблица `orders`

| Поле | Тип | Описание |
|---|---|---|
| id | serial | Номер заявки |
| address | text | Адрес объекта |
| owner_name | text | Чей объект |
| object_type | text | Тип объекта |
| object_name | text | Название (опц.) |
| has_video | boolean | Нужно видео |
| zones_info | text | Инфо о зонах |
| deadline | date | Крайний срок |
| contacts | text | Контакты |
| status | text | new/in_progress/done/cancelled |
| telegram_msg_id | bigint | ID сообщения в группе |
| submitted_by | bigint | Telegram ID кто подал |
| created_at | timestamptz | Время создания |

### Таблица `logs`

Каждое изменение статуса + создание заявки логируется с временем, актором и деталями.
