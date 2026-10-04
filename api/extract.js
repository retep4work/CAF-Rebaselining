// Vercel serverless function (FREE): forwards the image + prompt to Google Gemini.
// If a model is busy or out of quota, it retries and falls back to other models.
export const config = { maxDuration: 60 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "server_not_configured" });

  if (process.env.ACCESS_CODE && req.headers["x-access-code"] !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { prompt, image, mediaType } = req.body || {};
  if (!prompt || !image) return res.status(400).json({ error: "bad_request" });

  // Preferred model first, then fallbacks
  const models = [...new Set([
    process.env.GEMINI_MODEL || "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
  ])];

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [
      { inline_data: { mime_type: mediaType || "image/jpeg", data: image } },
      { text: prompt },
    ] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });

  const started = Date.now();
  const tried = [];
  let lastStatus = 502;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (Date.now() - started > 45000) break; // stay under the 60s function limit
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body }
        );
        const out = await r.json().catch(() => ({}));

        if (r.ok) {
          const text = (out.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
          try {
            const data = JSON.parse(text.replace(/```json|```/g, "").trim());
            return res.status(200).json({ data, model });
          } catch {
            tried.push(`${model}: invalid JSON`);
            break; // try next model
          }
        }

        lastStatus = r.status;
        const msg = out?.error?.message || "";
        tried.push(`${model}: ${r.status} ${msg.slice(0, 120)}`);

        // Busy / server trouble: wait and retry the same model once
        if ((r.status === 503 || r.status === 500) && attempt === 1) { await sleep(2000); continue; }
        // Quota, not found, or still busy: move on to the next model
        if ([429, 404, 503, 500].includes(r.status)) break;
        // Anything else (e.g. 400 bad request / bad key) won't be fixed by another model
        return res.status(502).json({ error: "upstream_error", detail: `[model: ${model}] ${msg}` });
      } catch (e) {
        tried.push(`${model}: ${String(e).slice(0, 100)}`);
        break;
      }
    }
  }

  const error = lastStatus === 429 ? "rate_limited" : "upstream_error";
  return res.status(lastStatus === 429 ? 429 : 502).json({
    error,
    detail: "All models were busy or out of free quota. Wait a minute and try again.\n\nTried:\n" + tried.join("\n"),
  });
}
