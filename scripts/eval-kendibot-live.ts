// Explicit, low-volume live API smoke test. Never send real customer data.
// Run: npx tsx --import dotenv/config scripts/eval-kendibot-live.ts --live
import { callGemini } from '../modules/whatsapp/gemini-agent.js';

async function main() {
if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize paid model calls.');
if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_NOT_CONFIGURED');
const examples = [
  { id: 'pidgin_freezer', text: 'Omo my frezzer no dey cold again. Abeg I need person tomorrow morning.', keywords: /freezer|frezzer/i },
  { id: 'english_plumbing', text: 'Please I need a plumber for a leaking tap.', keywords: /tap|plumb/i },
];
let failed = 0;
for (const item of examples) {
  const started = Date.now();
  try {
    const response = await callGemini({
      model: 'configured', max_tokens: 300,
      system: 'You are Kendibot, a Nigerian home-services assistant. Do not invent a diagnosis. Save the customer problem with save_request.',
      messages: [{ role: 'user', content: item.text }],
      tools: [{ name: 'save_request', description: 'Capture the requested service and problem.', input_schema: { type: 'object', properties: { need: { type: 'string' }, trade: { type: 'string' } }, required: ['need'], additionalProperties: false } }],
    } as any);
    const tool = response.content.find((block) => block.type === 'tool_use' && block.name === 'save_request') as any;
    const ok = Boolean(tool && item.keywords.test(JSON.stringify(tool.input)));
    if (!ok) failed++;
    console.log(JSON.stringify({ case: item.id, passed: ok, elapsedMs: Date.now() - started, selectedModel: tool?.geminiModel ?? null }));
  } catch (e) {
    failed++;
    console.log(JSON.stringify({ case: item.id, passed: false, elapsedMs: Date.now() - started, error: (e as Error).message }));
  }
}
if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
