// netlify/functions/today.js
//
// GET /api/today                       -> 今日(JST)の予定をJSONで返す
// GET /api/today?date=YYYY-MM-DD        -> 指定日の予定をJSONで返す
//
// tools/assaultlily_today.rb (CLI版) と同じロジックのHTTP版。ロジックを変更する
// 場合は両方に反映すること。依存は Node 標準モジュールのみ。

const https = require("https");

const DATA_URL = "https://cal.assaultli.ly/data/assaultlily_events.json";

const TYPE_LABELS = {
  stage: "舞台",
  event: "イベント",
  fc_event: "FCイベント",
  live_event: "ライブ",
  game_event: "ゲーム内イベント",
  broadcast: "生放送/配信",
  goods_sale: "物販",
  news: "お知らせ",
};

// Ruby版の `%w[月 火 水 木 金 土 日][wday - 1]`（wday: 0=日）と同じ並び。
const WEEKDAY_JA = ["月", "火", "水", "木", "金", "土", "日"];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "assaultlily-today-fn/1.0 (+https://cal.assaultli.ly)" } }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// サーバーのタイムゾーンに関わらずJSTの「今日」を YYYY-MM-DD で返す。
function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function isValidDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

function weekdayJa(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return WEEKDAY_JA[(d.getUTCDay() + 6) % 7];
}

function dateInRange(target, startStr, endStr) {
  if (!startStr) return false;
  const end = endStr || startStr;
  return target >= startStr && target <= end;
}

function ticketToday(target, ticket) {
  const s = ticket.sales_start;
  if (!s) return false;
  const start = s.slice(0, 10);
  const end = ticket.sales_end ? ticket.sales_end.slice(0, 10) : start;
  return target >= start && target <= end;
}

// 対象日が販売開始日そのものかどうか（初日=開始時刻、それ以外=期間中の状態表示）
function isFirstDay(target, salesStart) {
  if (!salesStart) return true;
  return salesStart.slice(0, 10) === target;
}

// 販売方式に応じた「期間中（初日以外）」の表示文言。ruby版 ongoing_label と同じ。
function ongoingLabel(method, salesStart) {
  if (method === "抽選") return "受付中";
  if (method === "先着") return "販売中";
  if (salesStart) return `${salesStart.slice(5, 7)}/${salesStart.slice(8, 10)}〜`;
  return "開催中";
}

function ticketEntry(target, ev, t) {
  const firstDay = isFirstDay(target, t.sales_start);
  return {
    event_id: ev.id,
    title: ev.title,
    type: ev.type,
    type_label: TYPE_LABELS[ev.type] || ev.type,
    phase: t.phase || null,
    method: t.method || null,
    is_first_day: firstDay,
    label: firstDay
      ? (t.sales_start ? t.sales_start.slice(11, 16) : null)
      : ongoingLabel(t.method, t.sales_start),
    sales_start: t.sales_start || null,
    sales_end: t.sales_end || null,
    price: t.price || null,
    url: t.url || null,
    note: t.note || null,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "GETのみ対応しています" }) };
  }

  const qs = event.queryStringParameters || {};
  const target = qs.date && isValidDateStr(qs.date) ? qs.date : todayJST();

  let data;
  try {
    data = await fetchJson(DATA_URL);
  } catch (e) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: `データの取得に失敗しました: ${e.message}` }),
    };
  }

  const events = data.events || [];

  // 開催中（goods_saleは「物販/通販」に一本化するため除外 - カレンダー側と同じ理由）
  const ongoing = events
    .filter((ev) => ev.type !== "goods_sale" && dateInRange(target, ev.date_start, ev.date_end))
    .map((ev) => ({
      event_id: ev.id,
      title: ev.title,
      type: ev.type,
      type_label: TYPE_LABELS[ev.type] || ev.type,
      venue: ev.venue || null,
      date_start: ev.date_start,
      date_end: ev.date_end || ev.date_start,
    }));

  // 個別公演回
  const performances = [];
  for (const ev of events) {
    for (const p of ev.performances || []) {
      if (p.date !== target) continue;
      performances.push({
        event_id: ev.id,
        title: ev.title,
        type: ev.type,
        type_label: TYPE_LABELS[ev.type] || ev.type,
        time: p.time || null,
        note: p.note || null,
      });
    }
  }
  performances.sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  // チケット販売 / 物販・通販
  const tickets = [];
  const mailorder = [];
  const mailorderEventIdsToday = new Set();
  for (const ev of events) {
    for (const t of ev.tickets || []) {
      if (!ticketToday(target, t)) continue;
      const entry = ticketEntry(target, ev, t);
      if (ev.type === "goods_sale") {
        mailorder.push(entry);
        mailorderEventIdsToday.add(ev.id);
      } else {
        tickets.push(entry);
      }
    }
  }
  // tickets情報を持たない（またはtickets側の期間と食い違う）goods_saleイベントの
  // フォールバック - date_start〜date_endの範囲だけで判定する。
  for (const ev of events) {
    if (ev.type !== "goods_sale") continue;
    if (mailorderEventIdsToday.has(ev.id)) continue;
    if (!dateInRange(target, ev.date_start, ev.date_end)) continue;
    mailorder.push({
      event_id: ev.id,
      title: ev.title,
      type: ev.type,
      type_label: TYPE_LABELS[ev.type] || ev.type,
      phase: null,
      method: null,
      is_first_day: null,
      label: "開催中",
      sales_start: null,
      sales_end: null,
      price: null,
      url: null,
      note: null,
      date_start: ev.date_start,
      date_end: ev.date_end || ev.date_start,
    });
  }
  tickets.sort((a, b) => (a.sales_start || "").localeCompare(b.sales_start || ""));
  mailorder.sort((a, b) => (a.sales_start || "").localeCompare(b.sales_start || ""));

  const body = {
    date: target,
    weekday: weekdayJa(target),
    ongoing,
    performances,
    tickets,
    mailorder,
    generated_at: new Date().toISOString(),
    source: "https://cal.assaultli.ly",
  };

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
    body: JSON.stringify(body, null, 2),
  };
};
