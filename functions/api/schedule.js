// functions/api/schedule.js
// 同一份試算表：前面幾欄設定直播時間，後面幾欄是請假日。
// 大陸觀眾打的是這個網址，由 Cloudflare 代向 Google 拿資料。
//
// 第一列請用這幾個標題（順序可以調，名稱要對得上）：
//   類型,班別,星期,開始,結束,日期,備註
//
// 直播列：填星期和開始、結束（台灣時間）。日期留空。
//   直播,晚班,五六日,20:00,23:30,,
//   直播,早班,六日,08:30,11:00,,
// 星期可寫五六日、六日，或 5,6,0（日=0）。開始結束用 24 小時制。
// 0:00:00、24:00 都當成午夜。試算表若把午夜發佈成 12:00:00，也會當成 00:00。
// 中午請寫 12:00，不要寫成 12:00:00。
//
// 請假列：類型填請假，日期用純文字 YYYY-MM-DD（台灣日期），班別填早班、午班、晚班、夜班或全天。
//   請假,夜班,,,,2026-10-17,請假
//   請假,全天,,,,2026-10-18,出國
//
// 舊的三欄（日期,班別,備註）仍然認得，只會當成請假，不會當成直播時間。
// 改完約 5 分鐘內網站會更新。

const GOOGLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRoAwG6qijdbcOLfIK4jLzCbDUbEomibWx4KvMSf8wBW-97fP_JfCvdkeSKA3z2IAKoYRJygRbx_S2t/pub?output=csv";

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQ = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      row.push(cur.trim());
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && n === "\n") i++;
      row.push(cur.trim());
      rows.push(row);
      row = [];
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur !== "" || row.length) {
    row.push(cur.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ""));
}

function normDate(value) {
  const m = String(value || "").trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function normTime(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^(上午|下午|am|pm)?\s*(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?\s*(上午|下午|am|pm)?$/i);
  if (!m) return "";
  let h = parseInt(m[2], 10);
  const min = parseInt(m[3], 10);
  const sec = m[4] ? parseInt(m[4], 10) : 0;
  const mark = String(m[1] || m[5] || "").toLowerCase();
  if (min > 59 || sec > 59) return "";
  if (h === 24 && min === 0 && sec === 0) h = 0;
  else if (h > 23) return "";
  if (mark === "pm" || mark === "下午") {
    if (h < 12) h += 12;
  } else if (mark === "am" || mark === "上午" || mark === "凌晨") {
    if (h === 12) h = 0;
  } else if (h === 12 && min === 0 && sec === 0 && m[4]) {
    // 試算表畫面是 0:00:00（午夜），發佈成 CSV 會變成 12:00:00。
    h = 0;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function normShift(value) {
  const t = String(value || "").trim().toLowerCase();
  if (["morning", "am", "m", "早", "早班"].includes(t)) return "morning";
  if (["afternoon", "noon", "午", "午班"].includes(t)) return "afternoon";
  if (["late", "深夜"].includes(t)) return "late";
  if (["evening", "night", "pm", "n", "晚", "晚班", "夜", "夜班"].includes(t)) return "evening";
  if (["all", "both", "a", "全天", "整天", "全日"].includes(t)) return "all";
  return "";
}

function normDays(value) {
  const src = String(value || "").trim();
  if (!src) return [];
  const found = [];
  const push = (d) => { if (!found.includes(d)) found.push(d); };
  const zh = { "日": 0, "天": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6 };
  for (const ch of src) if (zh[ch] !== undefined) push(zh[ch]);
  if (found.length) return found;

  const re = /sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat/gi;
  const word = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  let m;
  while ((m = re.exec(src))) {
    push(word[m[0].slice(0, 3).toLowerCase()]);
  }
  if (found.length) return found;
  if (/[:：]/.test(src)) return [];
  for (const num of src.match(/\d+/g) || []) {
    const n = parseInt(num, 10);
    if (n === 7) push(0);
    else if (n >= 0 && n <= 6) push(n);
  }
  return found;
}

function rowKind(value) {
  const t = String(value || "").trim().toLowerCase();
  if (["直播", "開台", "schedule", "live", "slot", "on"].includes(t)) return "live";
  if (["請假", "休息", "off", "dayoff", "leave"].includes(t)) return "off";
  return "";
}

function looksLikeHeader(row) {
  return /類型|班別|星期|開始|結束|日期|備註|type|shift|day|start|end|date|note/i.test(row.join(","));
}

function colIndex(header, names) {
  const cells = header.map((h) => String(h || "").toLowerCase());
  for (let i = 0; i < cells.length; i++) {
    if (names.some((n) => cells[i].includes(n))) return i;
  }
  return -1;
}

function cell(row, index) {
  return index >= 0 ? String(row[index] || "").trim() : "";
}

export function parseScheduleCsv(csv) {
  const rows = parseCSV(csv);
  const slots = [];
  const offs = [];
  const seenSlot = new Set();
  const seenOff = new Map();

  const addSlot = (days, start, end) => {
    if (!days.length || !start || !end) return;
    const key = `${days.join(".")}|${start}|${end}`;
    if (seenSlot.has(key)) return;
    seenSlot.add(key);
    slots.push({ days, start, end });
  };
  const addOff = (date, shift, note) => {
    if (!date || !shift) return;
    const noteText = String(note || "").trim().slice(0, 80);
    if (shift === "all") {
      seenOff.delete(`${date}|morning`);
      seenOff.delete(`${date}|afternoon`);
      seenOff.delete(`${date}|evening`);
      seenOff.delete(`${date}|late`);
    } else if (seenOff.has(`${date}|all`)) {
      return;
    }
    seenOff.set(`${date}|${shift}`, { date, shift, note: noteText });
  };

  if (!rows.length) return { slots, daysOff: [] };

  if (looksLikeHeader(rows[0])) {
    const header = rows[0];
    const iType = colIndex(header, ["類型", "type", "種類"]);
    const iShift = colIndex(header, ["班別", "shift"]);
    const iDays = colIndex(header, ["星期", "weekday", "days", "dow"]);
    const iStart = colIndex(header, ["開始", "start", "開台"]);
    const iEnd = colIndex(header, ["結束", "end", "收台"]);
    const iDate = colIndex(header, ["日期", "date", "請假日"]);
    const iNote = colIndex(header, ["備註", "note", "說明"]);
    for (const row of rows.slice(1)) {
      const kind = rowKind(cell(row, iType));
      const start = normTime(cell(row, iStart));
      const end = normTime(cell(row, iEnd));
      const days = normDays(cell(row, iDays));
      const date = normDate(cell(row, iDate));
      const shift = normShift(cell(row, iShift));
      const note = cell(row, iNote);
      if (kind === "live" || (!kind && start && end && days.length)) addSlot(days, start, end);
      if (kind === "off" || (!kind && date)) addOff(date, shift || "all", note);
      if (kind === "live" && date) addOff(date, shift || "all", note);
    }
  } else {
    for (const row of rows) {
      const kind = rowKind(row[0]);
      if (kind === "live") {
        addSlot(normDays(row[2]), normTime(row[3]), normTime(row[4]));
        continue;
      }
      if (kind === "off") {
        addOff(normDate(row[5] || row[4] || row[2]), normShift(row[1]), row[6] || row[5] || row[3] || "");
        continue;
      }
      const legacyDate = normDate(row[0]);
      if (legacyDate) {
        addOff(legacyDate, normShift(row[1]), row[2] || "");
        continue;
      }
      const start = normTime(row[2]);
      const end = normTime(row[3]);
      const days = normDays(row[1]);
      if (start && end && days.length) addSlot(days, start, end);
    }
  }

  slots.sort((a, b) => a.start.localeCompare(b.start) || a.days[0] - b.days[0]);
  return { slots, daysOff: [...seenOff.values()].sort((a, b) => (a.date + a.shift).localeCompare(b.date + b.shift)) };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300"
    }
  });
}

export async function onRequest() {
  if (!GOOGLE_SHEET_CSV_URL) {
    return json({ ok: true, configured: false, slots: [], daysOff: [] }, 200);
  }
  try {
    const response = await fetch(GOOGLE_SHEET_CSV_URL, {
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!response.ok) return json({ ok: false, configured: true, slots: [], daysOff: [] }, 502);
    const parsed = parseScheduleCsv(await response.text());
    return json({ ok: true, configured: true, slots: parsed.slots, daysOff: parsed.daysOff }, 200);
  } catch (err) {
    return json({ ok: false, configured: true, error: err.message, slots: [], daysOff: [] }, 500);
  }
}
