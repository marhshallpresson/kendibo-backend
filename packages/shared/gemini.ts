// Minimal Gemini JSON client shared by AI-assisted features. The key travels in
// a header (never the URL), calls are bounded, and callers always receive null
// on any failure so they can fall back to deterministic logic. Model output is
// UNTRUSTED input: callers must validate it with zod before using it.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export function geminiConfigured(): boolean {
  return (process.env.GEMINI_API_KEY ?? '').trim().length > 0;
}

export async function geminiJson(prompt: string, opts: { timeoutMs?: number; maxOutputTokens?: number } = {}): Promise<unknown | null> {
  const key = (process.env.GEMINI_API_KEY ?? '').trim();
  if (!key) return null;
  const model = (process.env.GEMINI_MODEL ?? 'gemini-3.8-flash').trim();
  try {
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: opts.maxOutputTokens ?? 800 },
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
