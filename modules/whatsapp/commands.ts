// Slash commands on WhatsApp ("/" shows them all). The old one-word shortcuts
// (PAY, VERIFY, DONE, PROBLEM, AGENT, STOP) map to the same commands, so both
// forms always do the same thing.
import { TAG_RE } from './sessions.js';

export interface Command { cmd: string; arg: string; slash: boolean }

const WORDS: [RegExp, string][] = [
  [/^(pay|pay now|payment|make payment)[.!]*$/, 'pay'],
  [/^(done|it'?s done|job done|confirm|confirmed|yes it'?s done)[.!]*$/, 'done'],
  [/^(problem|report|not done|issue|complain|complaint)[.!]*$/, 'problem'],
  [/^(verify|verify me|verify id|kyc|id check)[.!]*$/, 'verify'],
  [/^(agent|talk to (a )?person|human)[.!]*$/, 'agent'],
  [/^(menu|commands)[.!]*$/, 'menu'],
];

/** What the customer asked for, or null when the text is not a command. */
export function parseCommand(text: string): Command | null {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower.startsWith('/')) {
    const [head, ...rest] = lower.slice(1).trim().split(/\s+/);
    const cmd = head || 'menu';
    return { cmd: cmd === 'help' || cmd === 'menu' ? 'menu' : cmd, arg: rest.join(' ').trim(), slash: true };
  }
  if (TAG_RE.test(t)) return { cmd: 'switch', arg: t.toUpperCase(), slash: false };
  for (const [re, cmd] of WORDS) if (re.test(lower)) return { cmd, arg: '', slash: false };
  return null;
}

export const BUILTIN = new Set(['menu', 'book', 'sessions', 'switch', 'status', 'pay', 'invoice', 'reschedule', 'cancel', 'verify', 'recover', 'agent', 'stop', 'done', 'problem', 'tier']);

/**
 * The command list. Trades come from the live catalog, shown by group (there
 * are too many to list one per line): each group with a few of its /<trade>
 * shortcuts. Every active trade id works as a command.
 */
export function menuText(categories: { id: string; name: string; groupId?: string; groupName?: string }[]): string {
  const groups: { name: string; ids: string[] }[] = [];
  for (const c of categories) {
    const key = c.groupName ?? 'Trades';
    const g = groups.find((x) => x.name === key);
    if (g) g.ids.push(c.id); else groups.push({ name: key, ids: [c.id] });
  }
  const trades = groups.length > 1 || categories.length > 10
    ? groups.map((g) => `• ${g.name}: ${g.ids.slice(0, 3).map((id) => `/${id}`).join(' ')}${g.ids.length > 3 ? ` +${g.ids.length - 3} more` : ''}`)
    : categories.map((c) => `/${c.id} – book ${c.name}`);
  return [
    "Here's everything you can type:",
    '',
    '/book – start a new request (pick a group, then the trade)',
    ...trades,
    '',
    '/sessions – see your open requests',
    '/switch AC-4821 – pick which request we\'re talking about',
    '/status – check your request',
    '/pay – pay for your booking',
    '/invoice – get your invoice',
    '/reschedule – change the date or time',
    '/cancel – cancel a request',
    '',
    '/verify – verify your ID',
    '/recover – get back your old account',
    '/agent – talk to a person',
    '/stop – turn off promotions',
  ].join('\n');
}

export const ONBOARDING_TIP = 'Tip: type / any time to see everything I can do. For example:\n/book – start a new request\n/status – check your request\n/agent – talk to a person';
