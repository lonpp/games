// functions/api/workshop.js
// 遊戲開發頁的 RimWorld 模組卡片資料：由 Cloudflare 代向 Steam 拿，瀏覽器不能直接讀 Steam（跨網域）。
//
//   /api/workshop          → 全部模組的資料（JSON）
//   /api/workshop?img=ID   → 那個模組的預覽圖（縮成 960×540 JPG，大陸也打得開）
//
// 模組清單從工作坊頁面自動抓，上傳新模組後不用改這裡；抓不到時用 KNOWN_IDS。
// 中英文標題與說明：讀 Steam 社群頁的 english / tchinese / schinese 三種語言版本。
// 訂閱、最愛人數：Steam 公開 API（GetPublishedFileDetails，不需要金鑰）。
// 結果在 Cloudflare 快取 1 小時。

const PROFILE = "https://steamcommunity.com/id/couchinc/myworkshopfiles?appid=294100";
const OWNER = "76561198826471162"; // couchinc 的 SteamID64，只顯示自己的模組
const KNOWN_IDS = ["3817038607", "3816975998", "3804959474"];
const LANGS = ["english", "tchinese", "schinese"];
const CACHE_SECONDS = 3600;

async function getText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (couchinc.pages.dev workshop cards)", "Accept-Language": "en" },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!res.ok) throw new Error(url + " " + res.status);
  return res.text();
}

async function listIds() {
  try {
    const html = await getText(PROFILE);
    const ids = [...new Set([...html.matchAll(/filedetails\/\?id=(\d+)/g)].map((m) => m[1]))];
    if (ids.length) return [...new Set(ids.concat(KNOWN_IDS))];
  } catch (e) {}
  return KNOWN_IDS;
}

async function details(ids) {
  const body = new URLSearchParams({ itemcount: String(ids.length) });
  ids.forEach((id, i) => body.append(`publishedfileids[${i}]`, id));
  const res = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("steam api " + res.status);
  const data = await res.json();
  return (data.response && data.response.publishedfiledetails) || [];
}

// 從社群頁取出標題和說明（說明裡有巢狀 div，要數層數找結尾）
function extract(html) {
  const t = html.match(/<div class="workshopItemTitle">([\s\S]*?)<\/div>/);
  const key = 'id="highlightContent">';
  const start = html.indexOf(key);
  if (!t || start < 0) return null;
  const from = start + key.length;
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = from;
  let depth = 1, m, end = -1;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }
  if (end < 0) return null;
  return { title: t[1].trim(), html: html.slice(from, end) };
}

async function localized(id) {
  const out = {};
  await Promise.all(LANGS.map(async (l) => {
    try { out[l] = extract(await getText(`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}&l=${l}`)); }
    catch (e) { out[l] = null; }
  }));
  return out;
}

async function buildData() {
  const ids = await listIds();
  const list = (await details(ids)).filter((f) =>
    f.result === 1 && String(f.creator) === OWNER && Number(f.visibility) === 0 && !f.banned);
  const items = await Promise.all(list.map(async (f) => ({
    id: f.publishedfileid,
    created: f.time_created,
    updated: f.time_updated,
    subs: f.subscriptions,
    favs: f.favorited,
    lifetimeSubs: f.lifetime_subscriptions,
    views: f.views,
    preview: f.preview_url,
    tags: (f.tags || []).map((t) => t.tag),
    size: Number(f.file_size) || 0,
    apiTitle: f.title,
    apiDesc: f.description,
    loc: await localized(f.publishedfileid),
  })));
  items.sort((a, b) => b.created - a.created);
  return { fetched: Math.floor(Date.now() / 1000), items };
}

async function previewImage(id) {
  const [f] = await details([id]);
  if (!f || f.result !== 1 || String(f.creator) !== OWNER || !f.preview_url) {
    return new Response("not found", { status: 404 });
  }
  const res = await fetch(f.preview_url + "?imw=960&imh=540&ima=fit&impolicy=Letterbox", {
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) return new Response("image error", { status: 502 });
  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const img = url.searchParams.get("img");
  try {
    if (img) {
      if (!/^\d{6,12}$/.test(img)) return new Response("bad id", { status: 400 });
      return await previewImage(img);
    }
    const cache = caches.default;
    const key = new Request(url.origin + "/api/workshop?v=1");
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = new Response(JSON.stringify(await buildData()), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
        "Access-Control-Allow-Origin": "*",
      },
    });
    context.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err && err.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
