// Facebook Login on the same Meta app as the WhatsApp integration.
//
// The app signs the person in with Facebook (expo-auth-session) and sends us
// the user access token. We never trust it as-is:
//   1. debug_token with our app access token ({app-id}|{app-secret}): the token
//      must be valid, unexpired and issued to OUR app.
//   2. /me with appsecret_proof (HMAC-SHA256 of the token with the app secret),
//      and the id must match the one debug_token reported.
// Data Deletion Request Callback: Meta posts a signed_request when a person
// removes the app or asks for their data to be deleted; we unlink the
// Facebook id and drop the Facebook photo, and return a status URL + code.
import crypto from 'node:crypto';

const cfg = () => ({
  appId: (process.env.FACEBOOK_APP_ID || process.env.META_APP_ID || '').trim(),
  // Same Meta app as WhatsApp, so the same App Secret.
  appSecret: (process.env.FACEBOOK_APP_SECRET || process.env.WHATSAPP_APP_SECRET || '').trim(),
  version: (process.env.WHATSAPP_GRAPH_VERSION || 'v26.0').trim(),
});
export const facebookConfigured = () => !!(cfg().appId && cfg().appSecret);

export interface FacebookProfile { id: string; name: string | null; email: string | null; picture: string | null }

export async function verifyFacebookToken(accessToken: string): Promise<FacebookProfile> {
  const c = cfg();
  if (!c.appId || !c.appSecret) throw new Error('FACEBOOK_NOT_CONFIGURED');
  if (!accessToken || accessToken.length < 20 || accessToken.length > 2000 || /\s/.test(accessToken)) throw new Error('BAD_FACEBOOK_TOKEN');
  const appToken = `${c.appId}|${c.appSecret}`;
  const dbg = await fetch(`https://graph.facebook.com/${c.version}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appToken)}`, { signal: AbortSignal.timeout(10_000) });
  if (!dbg.ok) throw new Error('BAD_FACEBOOK_TOKEN');
  const d = ((await dbg.json()) as { data?: { is_valid?: boolean; app_id?: string; user_id?: string; expires_at?: number } }).data ?? {};
  if (!d.is_valid || !d.user_id) throw new Error('BAD_FACEBOOK_TOKEN');
  if (String(d.app_id) !== c.appId) throw new Error('BAD_FACEBOOK_APP');
  if (d.expires_at && d.expires_at * 1000 < Date.now()) throw new Error('FACEBOOK_TOKEN_EXPIRED');
  const proof = crypto.createHmac('sha256', c.appSecret).update(accessToken).digest('hex');
  const me = await fetch(`https://graph.facebook.com/${c.version}/me?fields=id,name,email,picture.width(256).height(256)&access_token=${encodeURIComponent(accessToken)}&appsecret_proof=${proof}`, { signal: AbortSignal.timeout(10_000) });
  if (!me.ok) throw new Error('BAD_FACEBOOK_TOKEN');
  const p = (await me.json()) as { id?: string; name?: string; email?: string; picture?: { data?: { url?: string; is_silhouette?: boolean } } };
  if (!p.id || String(p.id) !== String(d.user_id)) throw new Error('BAD_FACEBOOK_TOKEN');
  return {
    id: String(p.id),
    name: p.name ? String(p.name).slice(0, 80) : null,
    // Facebook only returns an email the person has confirmed.
    email: p.email ? String(p.email).toLowerCase() : null,
    picture: p.picture?.data?.url && !p.picture.data.is_silhouette ? String(p.picture.data.url).slice(0, 500) : null,
  };
}

/** Meta's signed_request: base64url(HMAC-SHA256 signature).base64url(JSON payload). */
export function parseSignedRequest(signed: string): { user_id: string; issued_at?: number } | null {
  const c = cfg();
  if (!c.appSecret || !signed || signed.length > 4000) return null;
  const [sig, payload] = signed.split('.', 2);
  if (!sig || !payload) return null;
  const expected = crypto.createHmac('sha256', c.appSecret).update(payload).digest();
  const given = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { algorithm?: string; user_id?: string; issued_at?: number };
    if (String(data.algorithm).toUpperCase() !== 'HMAC-SHA256' || !data.user_id) return null;
    return { user_id: String(data.user_id), issued_at: data.issued_at };
  } catch { return null; }
}

export const facebookHash = (id: string) => crypto.createHmac('sha256', cfg().appSecret || 'kendibo-fb').update(id).digest('hex').slice(0, 32);
