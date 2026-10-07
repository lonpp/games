// functions/api/sheet.js
export async function onRequest(context) {
  // 你的 Google 試算表公開 CSV 網址
  const GOOGLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1HM6RiBeDevgyZrUvrmwGWNy7N20JG11FmW7_yW-ankY/edit?usp=sharing";

  try {
    // 透過 Cloudflare 節點向 Google 請求資料，並於節點快取 300 秒（5 分鐘）
    const response = await fetch(GOOGLE_SHEET_CSV_URL, {
      cf: {
        cacheTtl: 300,
        cacheEverything: true
      }
    });

    if (!response.ok) {
      return new Response("Failed to fetch sheet from Google", { status: 502 });
    }

    const csvData = await response.text();

    // 回傳純文字 CSV，並允許跨域存取與瀏覽器快取
    return new Response(csvData, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300"
      }
    });
  } catch (err) {
    return new Response(`Proxy Error: ${err.message}`, { status: 500 });
  }
}