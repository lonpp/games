// functions/api/schedule.js
// 請假不開台。大陸觀眾打的是這個網址，由 Cloudflare 代向 Google 拿資料，所以觀眾不用翻牆。
//
// 試算表請另開一份（不要用商店那份），第一列標題，從第二列開始：
//   日期        班別     備註
//   2026-10-17  夜班     請假
//   2026-10-18  全天     出國
// 日期用純文字 YYYY-MM-DD（台灣日期）。班別只能填：早班、夜班、全天。
// 發佈：檔案 → 共用 → 發佈到網路 → 這個工作表 → 逗號分隔值 (.csv) → 發佈，
// 把網址貼進下面的 GOOGLE_SHEET_CSV_URL。改完約 5 分鐘內網站會更新。

const GOOGLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRoAwG6qijdbcOLfIK4jLzCbDUbEomibWx4KvMSf8wBW-97fP_JfCvdkeSKA3z2IAKoYRJygRbx_S2t/pub?output=csv";

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQ = false;
  const src = text.replace(/^\uFEFF/, "");
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

function normShift(value) {
  const t = String(value || "").trim().toLowerCase();
  if (["morning", "am", "m", "早", "早班"].includes(t)) return "morning";
  if (["night", "pm", "n", "夜", "夜班"].includes(t)) return "night";
  if (["all", "both", "a", "全天", "整天", "全日"].includes(t)) return "all";
  return "";
}

function daysOffFromCSV(csv) {
  const byKey = new Map();
  for (const r of parseCSV(csv)) {
    const date = normDate(r[0]);
    const shift = normShift(r[1]);
    if (!date || !shift) continue;
    const note = String(r[2] || "").trim().slice(0, 80);
    if (shift === "all") {
      byKey.delete(`${date}|morning`);
      byKey.delete(`${date}|night`);
    } else if (byKey.has(`${date}|all`)) {
      continue;
    }
    byKey.set(`${date}|${shift}`, { date, shift, note });
  }
  return [...byKey.values()].sort((a, b) => (a.date + a.shift).localeCompare(b.date + b.shift));
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
    return json({ ok: true, configured: false, daysOff: [] }, 200);
  }

  try {
    const response = await fetch(GOOGLE_SHEET_CSV_URL, {
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!response.ok) {
      return json({ ok: false, configured: true, daysOff: [] }, 502);
    }
    const daysOff = daysOffFromCSV(await response.text());
    return json({ ok: true, configured: true, daysOff }, 200);
  } catch (err) {
    return json({ ok: false, configured: true, error: err.message, daysOff: [] }, 500);
  }
}
