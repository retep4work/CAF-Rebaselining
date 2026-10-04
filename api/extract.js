// Vercel serverless function (FREE): forwards the image + prompt to Google Gemini.
// Your key lives in the GEMINI_API_KEY environment variable, never in the browser.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "server_not_configured" });

  // Optional: set ACCESS_CODE in Vercel so only people you share the code with can use it
  if (process.env.ACCESS_CODE && req.headers["x-access-code"] !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { prompt, image, mediaType } = req.body || {};
  if (!prompt || !image) return res.status(400).json({ error: "bad_request" });

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { inline_data: { mime_type: mediaType || "image/jpeg", data: image } },
              { text: prompt },
            ],
          }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      }
    );

    if (r.status === 429) return res.status(429).json({ error: "rate_limited" });
    const out = await r.json();
    if (!r.ok) return res.status(502).json({ error: "upstream_error", detail: out?.error?.message });

    const text = (out.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    const clean = text.replace(/```json|```/g, "").trim();
    try {
      return res.status(200).json({ data: JSON.parse(clean) });
    } catch {
      return res.status(502).json({ error: "invalid_json", detail: text.slice(0, 1000) });
    }
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e) });
  }
}
