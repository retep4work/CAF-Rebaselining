// Visit /api/models to see which Gemini models your key can use for image reading.
export default async function handler(req, res) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": key },
  });
  const out = await r.json();
  if (!r.ok) return res.status(502).json(out);
  const usable = (out.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => m.name.replace("models/", ""))
    .filter(n => /flash|lite/i.test(n));
  res.status(200).json({
    currentlySetModel: process.env.GEMINI_MODEL || "(not set, using default gemini-2.5-flash)",
    modelsYouCanTry: usable,
  });
}
