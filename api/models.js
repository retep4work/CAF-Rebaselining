// Visit /api/models           -> shows your settings and the models your key can use.
// Visit /api/models?test=1    -> ALSO sends a tiny test request to each full Flash model with each key,
//                                so you can see which ones have free quota right now (uses a few tokens).
export const config = { maxDuration: 60 };

const BASE = "https://generativelanguage.googleapis.com/v1beta";
// Full Flash models worth testing, in order of preference (lite / tts / image / omni models are skipped on purpose)
const PREFERRED = [
  "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash",
  "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash",
];

export default async function handler(req, res) {
  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2]
    .map(k => (k || "").trim()).filter(Boolean);
  if (!keys.length) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });

  const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": keys[0] } });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json(out);

  const usable = (out.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => m.name.replace("models/", ""))
    .filter(n => /flash|lite/i.test(n));

  const info = {
    currentlySetModel: process.env.GEMINI_MODEL || "(not set, using default gemini-flash-latest)",
    strictModel: process.env.STRICT_MODEL === "1",
    keysConfigured: keys.length,
    modelsYouCanTry: usable,
  };

  if (req.query && req.query.test) {
    const list = PREFERRED.filter(m => m === "gemini-flash-latest" || usable.includes(m));
    const tests = await Promise.all(list.flatMap(model => keys.map(async (key, ki) => {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const r2 = await fetch(`${BASE}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Reply with OK" }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 32 },
          }),
          signal: ctl.signal,
        });
        const j = await r2.json().catch(() => ({}));
        clearTimeout(timer);
        const msg = (j?.error?.message || "").replace(/\s+/g, " ").slice(0, 450);
        return `${model} (key ${ki + 1}): ` + (r2.ok ? "OK - has free quota" : `HTTP ${r2.status} ${msg}`);
      } catch (e) {
        clearTimeout(timer);
        return `${model} (key ${ki + 1}): no answer (timeout)`;
      }
    })));
    info.test = tests;
    info.howToRead = "Pick the first model that says OK, set it as GEMINI_MODEL in Vercel, then redeploy. 429 = quota used up (or no free quota) for that model and key.";
  }

  return res.status(200).json(info);
}
