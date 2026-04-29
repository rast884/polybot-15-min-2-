/**
 * BTC 15M Virtual Trading Bot
 * - Точная копия 5m бота → адаптирована под 15-минутные раунды Polymarket
 * - Фиксированная ставка $5 (без стратегии ставок)
 * - Telegram уведомления о ставках, результатах, балансе
 * - Расписание: 09:00–00:00 МСК
 * - Деплой: Railway
 */

const admin     = require('firebase-admin');
const fetch     = require('node-fetch');
const WebSocket = require('ws');
const http      = require('http');

// ── CONSTANTS ─────────────────────────────────────────────────────────
const FIXED_BET      = 5;
const WIN_MULT       = 0.92;
const ROUND_MS       = 15 * 60 * 1000;
const WORK_START_UTC = 6;   // 09:00 МСК
const WORK_END_UTC   = 21;  // 00:00 МСК

// ── TELEGRAM ──────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT  = process.env.TG_CHAT_ID   || '';
let   tgOffset = 0;

async function tgSend(text, extra = {}) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', ...extra }),
      timeout: 8000,
    });
  } catch(e) { console.error('[TG]', e.message); }
}

async function tgSetCommands() {
  if (!TG_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMyCommands`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start',  description: '▶️ Запустить бота' },
          { command: 'stop',   description: '⏹ Остановить бота' },
          { command: 'status', description: '📊 Баланс и статистика' },
          { command: 'price',  description: '💲 Цена BTC и время до ставки' },
          { command: 'reset',  description: '♻️ Сбросить баланс до $100' },
          { command: 'help',   description: '📖 Список команд' },
        ]
      }),
      timeout: 8000,
    });
    console.log('[TG] Commands menu set');
  } catch(e) { console.error('[TG setCommands]', e.message); }
}

function fmtCountdown() {
  const rem = roundId() + ROUND_MS - Date.now();
  const min = Math.floor(rem / 60000);
  const sec = Math.floor((rem % 60000) / 1000);
  return min > 0 ? `${min}м ${sec}с` : `${sec}с`;
}

function fmtNextBetTime() {
  const nextRid = roundId() + ROUND_MS;
  return new Date(nextRid).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow' });
}

async function pollTg() {
  if (!TG_TOKEN) { setTimeout(pollTg, 5000); return; }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${tgOffset}&timeout=25`,
      { timeout: 30000 }
    );
    if (res.ok) {
      const data = await res.json();
      for (const upd of (data.result || [])) {
        tgOffset = upd.update_id + 1;
        const msg = upd.message;
        if (!msg || !msg.text) continue;
        if (TG_CHAT && String(msg.chat.id) !== String(TG_CHAT)) continue;
        await handleTgCmd(msg.text.trim().toLowerCase());
      }
    }
  } catch(e) { /* timeout ok */ }
  setTimeout(pollTg, 1000);
}

async function handleTgCmd(text) {
  if (!state) return;
  if (text === '/start' || text === '/старт') {
    _userBotOn = true;
    await STATE_REF.child('botOn').set(true);
    await tgSend(
      `▶️ <b>Бот запущен</b>\n` +
      `💰 Баланс: $${state.wallet.balance.toFixed(2)}\n` +
      `💵 Ставка: $${FIXED_BET} фиксированно\n` +
      `⏱ Интервал: 15 мин\n` +
      `🕐 Расписание: 09:00–00:00 МСК`
    );
  } else if (text === '/stop' || text === '/стоп') {
    _userBotOn = false;
    await STATE_REF.child('botOn').set(false);
    await tgSend(`⏹ <b>Бот остановлен</b>\n💰 Баланс: $${state.wallet.balance.toFixed(2)}`);
  } else if (text === '/status' || text === '/статус') {
    const w = state.wallet;
    const s = state.stats;
    const total = w.wins + w.losses;
    const wr = total > 0 ? ((w.wins / total) * 100).toFixed(1) : '0';
    const price = Math.round(currentPrice).toLocaleString('ru-RU');
    const countdown = fmtCountdown();
    const nowMSK = new Date().toLocaleString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Europe/Moscow' });
    const statusEmoji = shouldBotRun() ? '✅' : _userBotOn ? '🟡' : '🔴';
    const statusText  = shouldBotRun() ? 'АКТИВЕН' : _userBotOn ? 'ОЖИДАНИЕ' : 'ОСТАНОВЛЕН';

    // Активная ставка
    let betBlock = '';
    if (state.pendingBet && state.pendingBet.result === 'pending') {
      const b = state.pendingBet;
      const dirEmoji = b.direction === 'UP' ? '▲' : '▼';
      const dirText  = b.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ';
      const curP = Math.round(currentPrice).toLocaleString('ru-RU');
      const entryP = Math.round(b.startPrice).toLocaleString('ru-RU');
      const delta = currentPrice - b.startPrice;
      const deltaSign = delta >= 0 ? '+' : '';
      const isWinning = (b.direction === 'UP' && delta >= 0) || (b.direction === 'DOWN' && delta <= 0);
      const betEmoji = isWinning ? '🟢' : '🔴';
      betBlock =
        `\n\n${betEmoji} <b>Активная ставка ${dirEmoji} ${dirText}</b>` +
        `\n💲 Вход: $${entryP} → Сейчас: $${curP}` +
        `\n📉 Изменение: ${deltaSign}$${Math.round(Math.abs(delta))} (${deltaSign}${((delta/b.startPrice)*100).toFixed(2)}%)` +
        `\n⏱ Слот: ${b.window} МСК` +
        `\n💵 Ставка: $${b.betAmount}`;
    }

    await tgSend(
      `📊 <b>${nowMSK} МСК</b>\n\n` +
      `Статус: ${statusEmoji} <b>${statusText}</b>\n` +
      `BTC: <b>$${price}</b>\n\n` +
      `💰 $${w.balance.toFixed(2)} · P&L ${w.pnl >= 0 ? '+' : ''}$${w.pnl.toFixed(2)}\n` +
      `🎯 ✅ Выигрышей: ${w.wins} · ❌ Проигрышей: ${w.losses}\n` +
      `всего ${total} · Win rate ${wr}%\n` +
      `До слота: <b>${countdown}</b>` +
      betBlock
    );
  } else if (text === '/reset' || text === '/сброс') {
    await db.ref('btc15m/command').set('reset');
    await tgSend('♻️ <b>Сброс</b> — баланс $100');
  } else if (text === '/price' || text === '/цена') {
    const price = Math.round(currentPrice).toLocaleString('ru-RU');
    const countdown = fmtCountdown();
    const nextTime  = fmtNextBetTime();
    const pending   = state.pendingBet?.result === 'pending';
    const betInfo   = pending
      ? `\n\n⏳ <b>Активная ставка:</b> ${state.pendingBet.direction === 'UP' ? '📈 UP' : '📉 DOWN'} ${state.pendingBet.betAmount}\n💲 Вход: ${Math.round(state.pendingBet.startPrice).toLocaleString('ru-RU')}`
      : '';
    await tgSend(
      `💲 <b>BTC/USD: ${price}</b>\n` +
      `⏱ До следующей ставки: <b>${countdown}</b>\n` +
      `🕐 Время ставки: ${nextTime} МСК` +
      betInfo
    );
  } else if (text === '/help' || text === '/помощь') {
    await tgSend(
      `🤖 <b>BTC 15m Bot — Команды</b>\n\n` +
      `▶️ /start — запустить бота\n` +
      `⏹ /stop — остановить бота\n` +
      `📊 /status — баланс и статистика\n` +
      `💲 /price — цена BTC и время до ставки\n` +
      `♻️ /reset — сброс баланса до $100\n` +
      `📖 /help — этот список`
    );
  }
}

// ── ADVANCED ANALYSIS ─────────────────────────────────────────────────
let _orderFlow       = { imbalance:0, signal:'neu', score:0, fetched:0 };
let _roundStartPrice = 0;

async function fetchOrderFlow() {
  if (Date.now() - _orderFlow.fetched < 3000) return;
  try {
    const r = await fetch('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=25', { timeout:3000 });
    const d = await r.json();
    let bidVol=0, askVol=0;
    for(const [p,q] of (d.result?.b||[])) bidVol+=parseFloat(p)*parseFloat(q);
    for(const [p,q] of (d.result?.a||[])) askVol+=parseFloat(p)*parseFloat(q);
    const total=bidVol+askVol, imbalance=total>0?(bidVol-askVol)/total:0;
    let score=0;
    if      (imbalance> 0.20) score= 3.5;
    else if (imbalance> 0.10) score= 2.0;
    else if (imbalance<-0.20) score=-3.5;
    else if (imbalance<-0.10) score=-2.0;
    _orderFlow = { imbalance, score, fetched:Date.now() };
  } catch(e) {}
}

function calcVolatility(buf) {
  if(!buf||buf.length<10) return { isFlatMarket:false, range:0 };
  const recent=buf.slice(-60);
  const range=Math.max(...recent)-Math.min(...recent);
  const windows=[];
  for(let i=0;i+60<=buf.length;i+=60){const w=buf.slice(i,i+60);windows.push(Math.max(...w)-Math.min(...w));}
  const avgRange=windows.length?windows.reduce((a,b)=>a+b,0)/windows.length:range;
  return { isFlatMarket: range<40||(avgRange>0&&range<avgRange*0.30), range:parseFloat(range.toFixed(1)) };
}

function calcDeltaEntry(buf, startPrice, roundRemainMs) {
  const elapsed = ROUND_MS - roundRemainMs;
  if(!buf||buf.length<5||!startPrice) return { score:0, elapsed:Math.floor(elapsed/1000) };
  const priceDelta = ((buf[buf.length-1]-startPrice)/startPrice*100);
  const absDelta   = Math.abs(priceDelta);
  let score = 0;
  if(elapsed>=60000&&elapsed<=720000){
    if      (absDelta>0.08) score=priceDelta>0?3.5:-3.5;
    else if (absDelta>0.04) score=priceDelta>0?2.0:-2.0;
    else if (absDelta>0.02) score=priceDelta>0?1.0:-1.0;
  }
  return { score, priceDelta:parseFloat(priceDelta.toFixed(4)), elapsed:Math.floor(elapsed/1000) };
}

// ── FIREBASE ──────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db        = admin.database();
const STATE_REF = db.ref('btc15m/main');
const LOG_REF   = db.ref('btc15m/log');

// ── STATE ─────────────────────────────────────────────────────────────
let state        = null;
let currentPrice = 72000;
let priceBuffer  = [];
let wsConnected  = false;
let roundPlaced  = null;
let _userBotOn   = false;

function defaultState() {
  return {
    wallet:      { balance:100, pnl:0, wins:0, losses:0, totalBet:0, betNumber:0 },
    stats:       { bestStreak:0, curStreak:0, totalWin:0, totalLoss:0 },
    history:     [],
    botOn:       false,
    lastRoundId: null,
    pendingBet:  null,
    savedAt:     Date.now(),
  };
}

function isWorkingHours() {
  const h = new Date().getUTCHours();
  return h >= WORK_START_UTC && h < WORK_END_UTC;
}
function shouldBotRun() { return _userBotOn && isWorkingHours(); }

async function loadState() {
  try {
    const snap = await STATE_REF.once('value');
    if (snap.exists()) {
      const raw  = snap.val();
      const data = mergeWithDefault(raw);
      _userBotOn = data.botOn    === true;
          console.log(`[STATE] Баланс: $${data.wallet.balance} | botOn: ${_userBotOn}`);
      return data;
    }
  } catch(e) { console.error('[STATE]', e.message); }
  return defaultState();
}

function mergeWithDefault(data) {
  const def = defaultState();
  if (!data) return def;
  return {
    ...def,
    ...data,
    wallet: { ...def.wallet, ...(data.wallet || {}) },
    stats:  { ...def.stats,  ...(data.stats  || {}) },
    history: Array.isArray(data.history) ? data.history.slice(0, 200) : [],
  };
}

async function saveState() {
  try {
    state.savedAt  = Date.now();
    state.botOn    = _userBotOn;
    await STATE_REF.set(state);
  } catch(e) { console.error('[SAVE]', e.message); }
}

async function log(msg) {
  const time = new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Europe/Moscow' });
  console.log(`[${time} МСК] ${msg}`);
  try { await LOG_REF.push({ time, msg, ts:Date.now() }); } catch(e) {}
}

// ── ROUND HELPERS ─────────────────────────────────────────────────────
const roundId     = (t) => Math.floor((t || Date.now()) / ROUND_MS) * ROUND_MS;
const roundRemain = ()  => roundId() + ROUND_MS - Date.now();
const fmtWindow   = (rid) => {
  const f = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow' });
  return `${f(rid)}–${f(rid + ROUND_MS)}`;
};

// ── PRICE FEED ────────────────────────────────────────────────────────
function connectPolymarketWS() {
  try {
    const ws = new WebSocket('wss://ws-live-data.polymarket.com');
    ws.on('open', () => {
      wsConnected = true;
      ws.send(JSON.stringify({
        action:'subscribe',
        subscriptions:[{ topic:'crypto_prices_chainlink', type:'*', filters:JSON.stringify({ symbol:'btc/usd' }) }]
      }));
      console.log('[WS] Polymarket Chainlink подключён');
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.topic==='crypto_prices_chainlink' && msg.payload?.symbol==='btc/usd') {
          const p = parseFloat(msg.payload.value);
          if (p > 0) { currentPrice=p; priceBuffer.push(p); if (priceBuffer.length>900) priceBuffer.shift(); }
        }
      } catch(e) {}
    });
    ws.on('close', () => { wsConnected=false; setTimeout(connectPolymarketWS, 5000); });
    ws.on('error', (e) => { wsConnected=false; console.error('[WS]', e.message); });
  } catch(e) { setTimeout(connectPolymarketWS, 10000); }
}

async function fetchPriceFallback() {
  try {
    const r = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT', { timeout:5000 });
    const d = await r.json();
    const t = d.result?.list?.[0];
    if (t) { currentPrice=parseFloat(t.lastPrice); priceBuffer.push(currentPrice); if (priceBuffer.length>900) priceBuffer.shift(); }
  } catch(e) {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { timeout:5000 });
      const d = await r.json();
      if (d.bitcoin?.usd) { currentPrice=d.bitcoin.usd; priceBuffer.push(currentPrice); }
    } catch(e2) {}
  }
}

async function fetchKlines() {
  if (priceBuffer.length >= 30) {
    const buf = priceBuffer.slice(-90);
    const chunkSize = Math.max(1, Math.floor(buf.length/10));
    const candles = [];
    for (let i=0;i<10;i++) {
      const chunk = buf.slice(i*chunkSize,(i+1)*chunkSize);
      if (!chunk.length) continue;
      candles.push({ o:chunk[0], h:Math.max(...chunk), l:Math.min(...chunk), c:chunk[chunk.length-1], v:chunk.length });
    }
    if (candles.length>=5) return candles;
  }
  try {
    // 15-минутный интервал Bybit
    const r = await fetch('https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=15&limit=10', { timeout:5000 });
    const d = await r.json();
    return (d.result?.list||[]).reverse().map(k=>({ o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
  } catch(e) { return []; }
}

// ── POLYMARKET SENTIMENT ─────────────────────────────────────────────
// Основной сигнал: котировки рынка Polymarket на текущий 15m раунд
// Рынок агрегирует мнение тысяч трейдеров — лучший доступный индикатор

let pmUpProb   = 0.5;
let pmDownProb = 0.5;
let pmLastFetch = 0;
let pmFetchOk   = false;

async function fetchPolymarketSentiment() {
  // Обновляем каждые 30 секунд (рынок меняется)
  if (Date.now() - pmLastFetch < 30000) return;
  try {
    const nowSec     = Math.floor(Date.now() / 1000);
    const roundedSec = nowSec - (nowSec % 900);
    const slug       = `btc-up-or-down-${roundedSec}-et`;

    // Пробуем несколько вариантов slug
    const slugs = [
      `btc-up-or-down-${roundedSec}-et`,
      `will-btc-go-up-or-down-in-the-next-15-minutes-${roundedSec}`,
      `btc-updown-15m-${roundedSec}`,
    ];

    for (const s of slugs) {
      try {
        const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${s}`, { timeout:5000 });
        if (!r.ok) continue;
        const data   = await r.json();
        const market = data?.[0]?.markets?.[0];
        if (!market?.outcomePrices) continue;
        const prices = typeof market.outcomePrices === 'string'
          ? JSON.parse(market.outcomePrices)
          : market.outcomePrices;
        const up   = parseFloat(prices[0]);
        const down = parseFloat(prices[1]);
        if (isNaN(up) || isNaN(down)) continue;
        pmUpProb   = up;
        pmDownProb = down;
        pmFetchOk  = true;
        pmLastFetch = Date.now();
        console.log(`[PM] slug:${s} UP ${(up*100).toFixed(1)}% / DOWN ${(down*100).toFixed(1)}%`);
        return;
      } catch(_) {}
    }

    // Fallback: поиск через markets API
    const r2 = await fetch(
      `https://gamma-api.polymarket.com/markets?tag_slug=bitcoin&active=true&closed=false&limit=20`,
      { timeout:5000 }
    );
    if (r2.ok) {
      const markets = await r2.json();
      const m = markets.find(m => {
        const q = (m.question || m.title || '').toLowerCase();
        return (q.includes('btc') || q.includes('bitcoin')) && q.includes('15');
      });
      if (m?.outcomePrices) {
        const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        const up = parseFloat(prices[0]), down = parseFloat(prices[1]);
        if (!isNaN(up) && !isNaN(down)) {
          pmUpProb = up; pmDownProb = down; pmFetchOk = true;
          pmLastFetch = Date.now();
          console.log(`[PM] fallback UP ${(up*100).toFixed(1)}% / DOWN ${(down*100).toFixed(1)}%`);
        }
      }
    }
  } catch(e) {
    console.error('[PM]', e.message);
  }
}

// ── BTC TREND (из price buffer) ───────────────────────────────────────
function btcTrend() {
  if (priceBuffer.length < 10) return { dir: 'NONE', strength: 0 };

  // EMA быстрая (последние 20 тиков) vs медленная (последние 60 тиков)
  const fast = priceBuffer.slice(-20);
  const slow = priceBuffer.slice(-60);
  const emaFast = fast.reduce((a,b)=>a+b,0) / fast.length;
  const emaSlow = slow.reduce((a,b)=>a+b,0) / slow.length;

  // Momentum: изменение за последние 5 минут (~20 тиков)
  const priceNow  = priceBuffer[priceBuffer.length - 1];
  const price5ago = priceBuffer[Math.max(0, priceBuffer.length - 20)];
  const momPct    = (priceNow - price5ago) / price5ago * 100;

  const diff = (emaFast - emaSlow) / emaSlow * 100;

  let dir = 'NONE', strength = 0;
  if      (diff >  0.05 && momPct >  0.03) { dir = 'UP';   strength = Math.min(3, diff * 30); }
  else if (diff < -0.05 && momPct < -0.03) { dir = 'DOWN'; strength = Math.min(3, Math.abs(diff) * 30); }
  else if (diff >  0.02)                   { dir = 'UP';   strength = 1; }
  else if (diff < -0.02)                   { dir = 'DOWN'; strength = 1; }

  return { dir, strength, emaFast, emaSlow, momPct: parseFloat(momPct.toFixed(3)), diff: parseFloat(diff.toFixed(4)) };
}

// ── НОВЫЙ СИГНАЛ: Polymarket first ───────────────────────────────────
// Логика:
//   1. Главный сигнал — Polymarket odds (рынок умнее любого алгоритма)
//   2. Тренд BTC как подтверждение или фильтр
//   3. Пропуск если нет PM данных И нет чёткого тренда
//   4. Пропуск если PM и тренд противоречат друг другу сильно

function newSignal() {
  const trend   = btcTrend();
  const signals = [];
  let   skip    = false;

  // ── Polymarket ──
  const pmDiff  = pmUpProb - pmDownProb;   // > 0 = рынок ставит на UP
  const pmConf  = Math.max(pmUpProb, pmDownProb);
  let pmDir     = pmDiff >= 0 ? 'UP' : 'DOWN';
  let pmScore   = 0;

  if (pmFetchOk) {
    if      (pmConf >= 0.65) { pmScore = 5; signals.push(`PM:${pmDir}${(pmConf*100).toFixed(0)}%🔥`); }
    else if (pmConf >= 0.58) { pmScore = 3; signals.push(`PM:${pmDir}${(pmConf*100).toFixed(0)}%`); }
    else if (pmConf >= 0.53) { pmScore = 1; signals.push(`PM:${pmDir}${(pmConf*100).toFixed(0)}%`); }
    else {
      // Рынок почти 50/50 — слабый сигнал
      pmScore = 0;
      signals.push(`PM:50/50⚠`);
    }
    if (pmDir === 'DOWN') pmScore = -pmScore;
  } else {
    signals.push('PM:нет данных');
  }

  // ── BTC Trend ──
  let trendScore = 0;
  if (trend.dir !== 'NONE') {
    trendScore = trend.dir === 'UP' ? trend.strength : -trend.strength;
    signals.push(`ТРЕНД:${trend.dir}${trend.strength.toFixed(1)} mom:${trend.momPct>0?'+':''}${trend.momPct}%`);
  } else {
    signals.push('ТРЕНД:флет');
  }

  // ── Итоговый score ──
  // PM весит в 3× больше тренда
  const totalScore = pmScore * 3 + trendScore;
  const dir = totalScore >= 0 ? 'UP' : 'DOWN';
  const absScore = Math.abs(totalScore);

  // ── Фильтры пропуска ──
  // 1. Нет PM данных и нет тренда — пропуск
  if (!pmFetchOk && trend.dir === 'NONE') {
    skip = true;
    signals.push('⚠ПРОПУСК:нет данных');
  }

  // 2. PM 50/50 и тренд флет — непонятный рынок
  if (pmFetchOk && pmConf < 0.53 && trend.dir === 'NONE') {
    skip = true;
    signals.push('⚠ПРОПУСК:рынок неопределён');
  }

  // 3. PM и тренд прямо противоречат при слабом PM сигнале
  if (pmFetchOk && pmConf < 0.58 && trend.dir !== 'NONE' && trend.dir !== pmDir && trend.strength >= 2) {
    // В этом случае доверяем тренду больше
    signals.push('⚠КОНФЛИКТ:следуем тренду');
    // не пропускаем, но инвертируем
  }

  const conf = Math.min(85, Math.max(52, 52 + absScore * 3));
  const reason = `PM:${pmFetchOk?(pmUpProb*100).toFixed(1)+'%UP/'+((1-pmUpProb)*100).toFixed(1)+'%DN':'нет'} | ${signals.join(' | ')} | score:${totalScore.toFixed(1)} → ${dir} ${conf.toFixed(0)}%${skip?' ⚠ПРОПУСК':''}`;

  return { direction: dir, confidence: conf, reason, score: totalScore, skip, pmConf, pmDir, trend };
}

// ── BOT LOGIC ─────────────────────────────────────────────────────────
async function placeBet(rid) {
  if (roundPlaced === rid) return;
  if (!shouldBotRun()) return;
  if (state.wallet.balance < FIXED_BET) {
    await log('❌ Баланс недостаточен');
    await tgSend(`❌ <b>Баланс недостаточен</b>\nНужно $${FIXED_BET}, есть $${state.wallet.balance.toFixed(2)}`);
    _userBotOn = false;
    await saveState();
    return;
  }

  roundPlaced = rid;
  if (!_roundStartPrice) _roundStartPrice = currentPrice;
  if (!wsConnected) await fetchPriceFallback();
  await fetchPolymarketSentiment();
  const sig = newSignal();

  // skip отключён — ставим каждый раунд

  // $5 фиксированно
  state.wallet.balance   = parseFloat((state.wallet.balance - FIXED_BET).toFixed(2));
  state.wallet.totalBet += FIXED_BET;
  state.wallet.betNumber = (state.wallet.betNumber || 0) + 1;
  state.lastRoundId      = rid;
  const betNum = state.wallet.betNumber;

  state.pendingBet = {
    id:rid, direction:sig.direction, confidence:sig.confidence, reason:sig.reason,
    betAmount:FIXED_BET, startPrice:currentPrice, endPrice:null,
    window:fmtWindow(rid), result:'pending', pnl:0, ts:new Date().toISOString(),
    betNumber: betNum,
  };

  await saveState();
  await log(`🎯 #${betNum} ${sig.direction} $${FIXED_BET} @ $${Math.round(currentPrice)} | ${fmtWindow(rid)} | ${sig.confidence.toFixed(0)}%`);

  await tgSend(
    `🎯 <b>Ставка #${betNum}</b>\n` +
    `${sig.direction==='UP'?'📈 UP':'📉 DOWN'} · $${FIXED_BET}\n` +
    `💲 BTC: $${Math.round(currentPrice).toLocaleString('ru-RU')}\n` +
    `⏱ ${fmtWindow(rid)} МСК\n` +
    `🧠 ${sig.confidence.toFixed(0)}% уверенность\n` +
    `💰 Баланс: $${state.wallet.balance.toFixed(2)}`
  );
}

async function resolveBet() {
  const bet = state.pendingBet;
  if (!bet || bet.result !== 'pending') return;
  _roundStartPrice = 0;
  if (!wsConnected) await fetchPriceFallback();
  bet.endPrice = currentPrice;
  const up  = bet.endPrice >= bet.startPrice;
  const won = (bet.direction==='UP'&&up) || (bet.direction==='DOWN'&&!up);

  if (won) {
    const p = parseFloat((bet.betAmount*WIN_MULT).toFixed(2));
    state.wallet.balance = parseFloat((state.wallet.balance+bet.betAmount+p).toFixed(2));
    state.wallet.pnl     = parseFloat((state.wallet.pnl+p).toFixed(2));
    state.wallet.wins++;
    state.stats.curStreak++;
    state.stats.totalWin += p;
    if (state.stats.curStreak > state.stats.bestStreak) state.stats.bestStreak = state.stats.curStreak;
    bet.result='win'; bet.pnl=p;
    await log(`✅ WIN +${p.toFixed(2)} | Баланс: ${state.wallet.balance.toFixed(2)}`);
    const _wTotal = state.wallet.wins + state.wallet.losses;
    const _wWr = _wTotal > 0 ? (state.wallet.wins / _wTotal * 100).toFixed(1) : '0.0';
    await tgSend(
      `✅ <b>Победа #${bet.betNumber||_wTotal}</b> +${p.toFixed(2)}\n` +
      `W/L: ${state.wallet.wins}/${state.wallet.losses} · Win rate ${_wWr}%\n` +
      `${bet.direction==='UP'?'📈 UP':'📉 DOWN'}: ${Math.round(bet.startPrice).toLocaleString('ru-RU')} → ${Math.round(bet.endPrice).toLocaleString('ru-RU')}\n` +
      `💰 Баланс: <b>${state.wallet.balance.toFixed(2)}</b>`
    );
  } else {
    state.wallet.pnl    = parseFloat((state.wallet.pnl-bet.betAmount).toFixed(2));
    state.wallet.losses++;
    state.stats.curStreak = 0;
    state.stats.totalLoss += bet.betAmount;
    bet.result='loss'; bet.pnl=-bet.betAmount;
    await log(`❌ LOSS -${bet.betAmount} | Баланс: ${state.wallet.balance.toFixed(2)}`);
    const _lTotal = state.wallet.wins + state.wallet.losses;
    const _lWr = _lTotal > 0 ? (state.wallet.wins / _lTotal * 100).toFixed(1) : '0.0';
    await tgSend(
      `❌ <b>Проигрыш #${bet.betNumber||_lTotal}</b> -${bet.betAmount}\n` +
      `W/L: ${state.wallet.wins}/${state.wallet.losses} · Win rate ${_lWr}%\n` +
      `${bet.direction==='UP'?'📈 UP':'📉 DOWN'}: ${Math.round(bet.startPrice).toLocaleString('ru-RU')} → ${Math.round(bet.endPrice).toLocaleString('ru-RU')}\n` +
      `💰 Баланс: <b>${state.wallet.balance.toFixed(2)}</b>`
    );
  }

  bet.balanceAfter = state.wallet.balance;
  state.history.unshift({...bet});
  if (state.history.length > 200) state.history = state.history.slice(0,200);
  state.pendingBet = null;
  await saveState();
  if (state.wallet.balance < FIXED_BET) { _userBotOn=false; await saveState(); }
}

// ── SCHEDULE ──────────────────────────────────────────────────────────
let _wasWorkingHours = null;

async function checkSchedule() {
  const working = isWorkingHours();
  if (working === _wasWorkingHours) return;
  _wasWorkingHours = working;
  const hourMSK = (new Date().getUTCHours()+3) % 24;
  if (working) {
    if (_userBotOn) await log(`⏰ Рабочие часы (${hourMSK}:00 МСК) — бот активируется`);
    await STATE_REF.child('scheduleActive').set(true);
  } else {
    await log(`🌙 Ночное время (${hourMSK}:00 МСК) — пауза до 09:00 МСК`);
    await STATE_REF.child('scheduleActive').set(false);
    if (state.pendingBet?.result==='pending') await resolveBet();
  }
}

// ── MAIN TICK ─────────────────────────────────────────────────────────
async function tick() {
  if (!state) return;
  try {
    await checkSchedule();
    const rid = roundId();
    const rem = roundRemain();
    if (rem < 8000 && state.pendingBet?.result==='pending' && state.pendingBet?.id===rid) await resolveBet();
    if (rem > ROUND_MS-20000 && shouldBotRun()) await placeBet(rid);
    if (!wsConnected && Date.now()%60000 < 5000) await fetchPriceFallback();
  } catch(e) { console.error('[TICK]', e.message); }
}

// ── FIREBASE LISTENERS ────────────────────────────────────────────────
function listenForCommands() {
  STATE_REF.child('botOn').on('value', async (snap) => {
    const val = snap.val();
    if (typeof val==='boolean' && val!==_userBotOn) {
      _userBotOn = val;
      await log(_userBotOn ? '▶ Пользователь запустил бота' : '■ Пользователь остановил бота');
      if (!_userBotOn && state.pendingBet?.result==='pending') await resolveBet();
    }
  });

  db.ref('btc15m/command').on('value', async (snap) => {
    const cmd = snap.val();
    if (cmd==='reset') {
      state = defaultState();
      roundPlaced = null;
      await saveState();
      await db.ref('btc15m/command').remove();
      await log('♻️ Сброс — баланс $100');
    }
  });
}

// ── HTTP KEEPALIVE (Railway) ───────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok:         true,
    running:    _userBotOn,
    working:    isWorkingHours(),
    shouldRun:  shouldBotRun(),
    balance:    state?.wallet?.balance,
    wins:       state?.wallet?.wins,
    losses:     state?.wallet?.losses,
    betSize:    FIXED_BET,
    interval:   '15min',
    wsConnected,
    uptime:     Math.floor(process.uptime()),
  }));
}).listen(process.env.PORT || 3000, () => console.log(`[HTTP] Port ${process.env.PORT || 3000}`));

// ── START ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', (e) => console.error('[UnhandledRejection]', e?.message||e));
process.on('uncaughtException',  (e) => console.error('[UncaughtException]',  e?.message||e));

async function start() {
  console.log('🤖 BTC 15M Bot starting...');
  state = await loadState();
  if (!state) state = defaultState();
  state = mergeWithDefault(state);
  connectPolymarketWS();
  listenForCommands();
  pollTg();
  tgSetCommands();
  setInterval(tick, 5000);
  setInterval(async () => {
    try {
      await db.ref('btc15m/heartbeat').set({
        ts: Date.now(),
        working:   isWorkingHours(),
        hourMSK:   (new Date().getUTCHours()+3) % 24,
        userBotOn: _userBotOn,
        shouldRun: shouldBotRun(),
        wsConnected,
        balance:   state?.wallet?.balance,
      });
    } catch(e) {}
  }, 30000);
  const hourMSK = (new Date().getUTCHours()+3) % 24;
  await log(`🚀 Бот запущен | Баланс: $${state.wallet.balance} | ${hourMSK}:XX МСК | 09:00–00:00 МСК`);
  await tgSend(
    `🚀 <b>BTC 15m Bot запущен</b>\n` +
    `💰 Баланс: $${state.wallet.balance.toFixed(2)}\n` +
    `💵 Ставка: $${FIXED_BET} фиксированно\n` +
    `⏱ Интервал: 15 мин | Расписание: 09:00–00:00 МСК`
  );
  await tick();
}

start().catch(e => { console.error('Fatal:', e); process.exit(1); });
