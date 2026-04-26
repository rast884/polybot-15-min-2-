# BTC 15m Polymarket Bot

Точная копия 5m бота, адаптированная под **15-минутные раунды** Polymarket.
Фиксированная ставка **$5**. Telegram уведомления. Деплой на Railway.

---

## Отличия от 5m версии

| | 5m бот | 15m бот |
|---|---|---|
| Интервал | 5 мин | **15 мин** |
| Ставка | динамическая | **$5 фиксированно** |
| Firebase путь | btc5m/ | btc15m/ |
| Kline interval Bybit | interval=1 | **interval=15** |
| PM slug | btc-updown-5m-{ts} | **btc-updown-15m-{ts}** |
| Delta entry окно | 1–4 мин | **1–12 мин** |
| Price buffer | 300 тиков | **900 тиков** |
| Стратегия ставок | fixed/pct | **убрана** |

---

## Переменные Railway → Variables

| Переменная | Пример |
|---|---|
| FIREBASE_PROJECT_ID | btc-bot884 |
| FIREBASE_DATABASE_URL | https://btc-bot884-default-rtdb.firebaseio.com |
| FIREBASE_CLIENT_EMAIL | firebase-adminsdk@...iam.gserviceaccount.com |
| FIREBASE_PRIVATE_KEY | -----BEGIN PRIVATE KEY-----\n... |
| TG_BOT_TOKEN | 123456789:ABC... |
| TG_CHAT_ID | -1001234567890 |

FIREBASE_PRIVATE_KEY — вставляй как есть из JSON, Railway сам обработает \n

---

## Деплой на Railway

1. Создай репо GitHub, залей: bot.js, package.json, railway.toml
2. railway.app → New Project → Deploy from GitHub → выбери репо
3. Variables → добавь все переменные выше
4. Deploy → готово

---

## Telegram бот

1. @BotFather → /newbot → скопируй токен → TG_BOT_TOKEN
2. Добавь бота в чат
3. https://api.telegram.org/bot<TOKEN>/getUpdates → найди chat.id → TG_CHAT_ID

Команды: /start /stop /status /reset /help

---

## Firebase структура

btc15m/main      — состояние (баланс, история, настройки)
btc15m/log       — лог событий
btc15m/heartbeat — пинг каждые 30 сек
btc15m/command   — команды (reset)

