// Vercel serverless function (FREE): forwards the image + prompt to Google Gemini.
// If a model is busy or out of quota, it retries and falls back to other models.
export const config = { maxDuration: 60 };

const goodVariant = {}; // per-model thinking setting that worked (kept while the function is warm)

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  if (process.env.ACCESS_CODE && req.headers["x-access-code"] !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { prompt, image, mediaType, provider } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "bad_request" }); // image is optional (text-only edits)

  // The page's "Use Groq" tick box sends provider: "groq"; anything else means Gemini.
  if (provider === "groq") return handleGroq(res, { prompt, image, mediaType });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "server_not_configured" });

  // Preferred model first, then fallbacks
  const models = [...new Set([
    process.env.GEMINI_MODEL || "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
  ])];

  // Speed: turn model "thinking" down/off. Different Gemini generations name this differently,
  // so try the variants in order and remember the one each model accepts.
  const VARIANTS = [
    { thinkingConfig: { thinkingBudget: 0 } },
    { thinkingConfig: { thinkingLevel: "low" } },
    {},
  ];
  const makeBody = v => JSON.stringify({
    contents: [{ role: "user", parts: [
      ...(image ? [{ inline_data: { mime_type: mediaType || "image/jpeg", data: image } }] : []),
      { text: prompt },
    ] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", ...VARIANTS[v] },
  });

  const started = Date.now();
  const tried = [];
  let lastStatus = 502;

  for (const model of models) {
    let v = goodVariant[model] ?? 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (Date.now() - started > 32000) break; // leave room to answer before the function limit
      // Give up on one slow Gemini request after 22s so we can answer cleanly (and the page can retry) instead of a 504
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 22000);
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: makeBody(v), signal: ctl.signal }
        );
        const out = await r.json().catch(() => ({}));
        clearTimeout(timer);

        if (r.ok) {
          goodVariant[model] = v;
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
        // This model doesn't accept that thinking setting: try the next variant on the same attempt
        if (r.status === 400 && /think/i.test(msg) && v < VARIANTS.length - 1) { v++; attempt--; continue; }
        tried.push(`${model}: HTTP ${r.status} ${msg.slice(0, 120)}`);

        // Busy, overloaded, out of quota, or model missing: retry once, then try the next model
        const retryable =
          r.status >= 500 || [404, 408, 409, 429].includes(r.status) ||
          /demand|overload|unavailable|quota|exhausted|try again/i.test(msg);
        if (retryable) {
          if (attempt === 1 && !/quota|exhausted/i.test(msg) && r.status !== 404) { await sleep(2500); continue; }
          break;
        }
        // Real errors (bad request, bad key) won't be fixed by another model
        return res.status(502).json({ error: "upstream_error", detail: `[model: ${model}] (HTTP ${r.status}) ${msg}` });
      } catch (e) {
        clearTimeout(timer);
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

// ---------------------------------------------------------------------------
// Groq (OpenAI-compatible API). Uses a vision model; falls back to the next one if busy / out of quota.
// Env: GROQ_API_KEY (required), GROQ_MODEL (optional preferred model).
// ---------------------------------------------------------------------------
async function handleGroq(res, { prompt, image, mediaType }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: "server_not_configured" });

  const models = [...new Set([
    process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b",
  ])];

  // Qwen models "think" first, which is slow. Try with thinking off + JSON mode, then loosen if the model rejects a setting.
  const VARIANTS = [
    { reasoning_effort: "none", response_format: { type: "json_object" } },
    { response_format: { type: "json_object" } },
    {},
  ];
  const goodV = {};

  const makeBody = (model, v) => JSON.stringify({
    model,
    temperature: 0,
    ...VARIANTS[v],
    messages: [{ role: "user", content: [
      { type: "text", text: prompt },
      ...(image ? [{ type: "image_url", image_url: { url: `data:${mediaType || "image/jpeg"};base64,${image}` } }] : []),
    ] }],
  });

  const started = Date.now();
  const tried = [];
  let lastStatus = 502;

  for (const model of models) {
    let v = goodV[model] ?? 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (Date.now() - started > 32000) break;
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 22000);
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: makeBody(model, v),
          signal: ctl.signal,
        });
        const out = await r.json().catch(() => ({}));
        clearTimeout(timer);

        if (r.ok) {
          goodV[model] = v;
          // Drop any <think>…</think> reasoning the model may have included before the JSON
          const text = (out.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "");
          try {
            const data = JSON.parse(text.replace(/```json|```/g, "").trim());
            return res.status(200).json({ data, model: `groq:${model}` });
          } catch {
            tried.push(`${model}: invalid JSON`);
            break; // try next model
          }
        }

        lastStatus = r.status;
        const msg = out?.error?.message || "";
        // The model doesn't accept one of the optional settings: loosen them and retry
        if (r.status === 400 && /reasoning|response_format|json/i.test(msg) && v < VARIANTS.length - 1) { v++; attempt--; continue; }
        tried.push(`${model}: HTTP ${r.status} ${msg.slice(0, 120)}`);

        const retryable =
          r.status >= 500 || [404, 408, 409, 429].includes(r.status) ||
          /overload|unavailable|rate limit|quota|try again|capacity/i.test(msg);
        if (retryable) {
          if (attempt === 1 && r.status !== 429 && r.status !== 404) { await sleep(2500); continue; }
          break;
        }
        return res.status(502).json({ error: "upstream_error", detail: `[Groq model: ${model}] (HTTP ${r.status}) ${msg}` });
      } catch (e) {
        clearTimeout(timer);
        tried.push(`${model}: ${String(e).slice(0, 100)}`);
        break;
      }
    }
  }

  return res.status(lastStatus === 429 ? 429 : 502).json({
    error: lastStatus === 429 ? "rate_limited" : "upstream_error",
    detail: "Groq was busy or out of free quota. Wait a minute and try again, or untick Groq to use Gemini.\n\nTried:\n" + tried.join("\n"),
  });
}
