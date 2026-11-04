// Adapt the existing server-owned WhatsApp tools to Gemini's function-calling API.
// Tool execution and customer-facing messages remain in agent.ts.
import crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Part = Record<string, unknown>;

export async function callGemini(params: Params): Promise<Anthropic.Beta.BetaMessage> {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_NOT_CONFIGURED');
  // Keep a tool round-trip on the same model: thought signatures belong to the
  // model that produced them and must not be replayed to a different model.
  const priorModel = [...params.messages].reverse().flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((b: any) => b.type === 'tool_use' && b.geminiModel)?.geminiModel;
  const model = String(priorModel || process.env.WHATSAPP_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('INVALID_GEMINI_MODEL');
  const toolNames = new Map<string, string>();
  const contents: { role: 'user' | 'model'; parts: Part[] }[] = [];
  const append = (role: 'user' | 'model', parts: Part[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push(...parts); else contents.push({ role, parts });
  };
  for (const message of params.messages as any[]) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const parts: Part[] = [];
    for (const b of blocks || []) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'image' && b.source?.type === 'base64') parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
      else if (b.type === 'tool_use') {
        toolNames.set(b.id, b.name);
        parts.push({ functionCall: { name: b.name, args: b.input || {} }, ...(b.geminiThoughtSignature ? { thoughtSignature: b.geminiThoughtSignature } : {}) });
      } else if (b.type === 'tool_result') {
        const name = toolNames.get(b.tool_use_id);
        if (!name) throw new Error('GEMINI_UNKNOWN_TOOL_RESULT');
        let result: unknown = b.content;
        if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = { result }; } }
        parts.push({ functionResponse: { name, response: typeof result === 'object' && result !== null ? result : { result } } });
      }
    }
    append(role, parts);
  }
  const system = typeof params.system === 'string' ? params.system : (params.system || []).map((s: any) => s.text || '').join('\n');
  const tools = (params.tools || []).filter((t: any) => t.name && t.input_schema).map((t: any) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema }));
  const fallback = priorModel ? '' : (process.env.WHATSAPP_GEMINI_FALLBACK_MODEL ?? 'gemini-2.5-flash').trim();
  if (fallback && !/^[a-zA-Z0-9._-]+$/.test(fallback)) throw new Error('INVALID_GEMINI_FALLBACK_MODEL');
  const request = (selected: string) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${selected}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(25_000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: tools }], generationConfig: { maxOutputTokens: 2000 } }),
  });
  let response: Response;
  let usedFallback = false;
  try { response = await request(model); }
  catch (e) {
    if (!fallback || fallback === model) throw e;
    usedFallback = true;
    response = await request(fallback);
  }
  if (!usedFallback && (response.status === 429 || response.status >= 500) && fallback && fallback !== model) { usedFallback = true; response = await request(fallback); }
  if (!response.ok) throw new Error(`GEMINI_HTTP_${response.status}`);
  const json = await response.json() as any;
  const parts = json.candidates?.[0]?.content?.parts || [];
  const blocks = parts.flatMap((p: any) => {
    if (p.functionCall?.name) return [{ type: 'tool_use', id: crypto.randomUUID(), name: p.functionCall.name, input: p.functionCall.args || {}, geminiThoughtSignature: p.thoughtSignature, geminiModel: usedFallback ? fallback : model }];
    return typeof p.text === 'string' && !p.thought ? [{ type: 'text', text: p.text }] : [];
  });
  if (!blocks.length) throw new Error('GEMINI_EMPTY_RESPONSE');
  return { content: blocks, stop_reason: blocks.some((b: any) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' } as Anthropic.Beta.BetaMessage;
}
