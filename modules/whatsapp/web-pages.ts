// Server-rendered pages opened from WhatsApp buttons (in WhatsApp's in-app
// browser). Mobile-first, no framework, fast on 3G. Every interpolated value is
// HTML-escaped; scripts run under a per-request CSP nonce. The signed link
// token is the only credential and is echoed back on form posts.
import type { RankedVendor } from '../matching/matching.service.js';

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function pageCsp(nonce: string, withMaps: boolean): string {
  const g = withMaps ? ' https://maps.googleapis.com https://maps.gstatic.com' : '';
  return [
    "default-src 'self'",
    // strict-dynamic lets the Maps loader add its own scripts (Google's CSP guidance).
    `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline'${g} https://fonts.googleapis.com`,
    `img-src 'self' data: blob:${withMaps ? ' https://*.googleapis.com https://*.gstatic.com https://*.google.com' : ''}`,
    `font-src 'self' https://fonts.gstatic.com`,
    `connect-src 'self'${withMaps ? ' https://maps.googleapis.com https://places.googleapis.com' : ''}`,
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; ');
}

const BASE_CSS = `
:root{--ink:#0F172A;--sub:#475569;--line:#E2E8F0;--brand:#1D5BD6;--bg:#F6F7F9;--ok:#15803D;--okbg:#EAF6EE;--err:#B91C1C}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{padding:16px;background:#fff;border-bottom:1px solid var(--line)}h1{font-size:19px;margin:0}header p{margin:4px 0 0;color:var(--sub);font-size:14px}
main{padding:16px;max-width:560px;margin:0 auto}
label{display:block;font-weight:600;font-size:14px;margin:14px 0 6px}
input{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:#fff;min-height:48px}
input:focus{outline:2px solid var(--brand);outline-offset:1px}
.btn{display:block;width:100%;text-align:center;font:inherit;font-weight:700;border:0;border-radius:12px;padding:14px;min-height:48px;cursor:pointer;text-decoration:none}
.primary{background:var(--brand);color:#fff}.ghost{background:#fff;color:var(--brand);border:1px solid var(--line)}
.btn[disabled]{opacity:.55}
.note{font-size:13px;color:var(--sub);margin-top:8px}.err{color:var(--err);font-weight:600;font-size:14px;margin-top:10px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.chip{font:inherit;font-size:13px;border:1px solid var(--line);background:#fff;border-radius:999px;padding:8px 12px;min-height:36px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.badge{display:inline-block;font-size:12px;font-weight:600;color:var(--ok);background:var(--okbg);border-radius:999px;padding:3px 9px;margin:6px 6px 0 0}
ul.reasons{margin:10px 0 0;padding-left:18px;color:var(--sub);font-size:14px}
.done{text-align:center;padding:40px 16px}.done h2{margin:0 0 6px}
`;

const shell = (title: string, body: string, nonce: string, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#1D5BD6"><title>${esc(title)}</title>
<style>${BASE_CSS}</style></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;

const back = (waNumber?: string) => waNumber ? `<a class="btn primary" href="https://wa.me/${esc(waNumber.replace(/\D/g, ''))}">Back to WhatsApp</a>` : '<p class="note">You can close this page and go back to WhatsApp.</p>';

// ── Location picker ───────────────────────────────────────────────────────
export function renderLocationPage(opts: { token: string; nonce: string; mapsKey?: string; centre: { lat: number; lng: number }; waNumber?: string }): string {
  const hasMap = !!opts.mapsKey;
  const body = `
<header><h1>Where is the job?</h1><p>Drag the pin to the exact gate or door, then add a landmark.</p></header>
${hasMap ? '<div id="map" style="height:46vh;min-height:260px;background:#e5e7eb" role="application" aria-label="Map — drag the pin to your location"></div>' : ''}
<main>
  ${hasMap ? '<label for="search">Search an address or place</label><div id="search"></div>' : ''}
  <button class="btn ghost" id="gps" type="button" style="margin-top:12px">Use my current location</button>
  <label for="address">Address</label><input id="address" placeholder="House number, street, area" maxlength="200" autocomplete="street-address">
  <button class="btn ghost" id="find" type="button" style="margin-top:8px">Find this address</button>
  <p class="note" id="found" aria-live="polite" hidden></p>
  <label for="landmark">Nearest landmark</label><input id="landmark" placeholder="e.g. opposite Shoprite, blue gate" maxlength="120">
  <div class="chips" id="nearby" aria-live="polite"></div>
  <p class="err" id="err" role="alert" hidden></p>
  <button class="btn primary" id="save" type="button" style="margin-top:18px" disabled>Save location</button>
  <p class="note">Only your vendor sees the exact spot, after you book.</p>
</main>
<section class="done" id="done" hidden><h2>Location saved</h2><p class="note" id="doneMsg"></p>${back(opts.waNumber)}</section>`;
  const script = `
var T=${JSON.stringify(opts.token)},pos=null,map,marker,geocoder,places;
var $=function(i){return document.getElementById(i)};
function setPos(lat,lng,fromMap){pos={lat:lat,lng:lng};$('save').disabled=false;if(marker&&!fromMap){marker.setPosition(pos);map.panTo(pos)}if(geocoder){geocoder.geocode({location:pos},function(r,s){if(s==='OK'&&r[0]&&!$('address').dataset.touched){$('address').value=r[0].formatted_address}});}nearby();}
// Places API (New): Place.searchNearby + PlaceAutocompleteElement. Both are
// optional — the pin, GPS and typed address still work if Places is not enabled.
var nearbyTimer;function nearby(){if(!places||!pos)return;clearTimeout(nearbyTimer);nearbyTimer=setTimeout(function(){places.Place.searchNearby({fields:['displayName'],locationRestriction:{center:pos,radius:200},maxResultCount:4}).then(function(r){var box=$('nearby');box.innerHTML='';(r.places||[]).forEach(function(p){var n=p.displayName;if(!n)return;var b=document.createElement('button');b.type='button';b.className='chip';b.textContent='Near '+n;b.onclick=function(){$('landmark').value='Near '+n};box.appendChild(b)})}).catch(function(){})},400)}
window.initMap=async function(){var c=${JSON.stringify(opts.centre)};map=new google.maps.Map($('map'),{center:c,zoom:16,disableDefaultUI:true,zoomControl:true,gestureHandling:'greedy'});marker=new google.maps.Marker({position:c,map:map,draggable:true});geocoder=new google.maps.Geocoder();marker.addListener('dragend',function(){var p=marker.getPosition();setPos(p.lat(),p.lng(),true)});map.addListener('click',function(e){marker.setPosition(e.latLng);setPos(e.latLng.lat(),e.latLng.lng(),true)});try{places=await google.maps.importLibrary('places');var el=new places.PlaceAutocompleteElement({includedRegionCodes:['ng']});el.style.width='100%';$('search').appendChild(el);el.addEventListener('gmp-select',async function(ev){var pl=ev.placePrediction.toPlace();await pl.fetchFields({fields:['location','formattedAddress','displayName']});if(!pl.location)return;$('address').value=pl.formattedAddress||pl.displayName||'';$('address').dataset.touched='1';setPos(pl.location.lat(),pl.location.lng())})}catch(e){var s=$('search');if(s)s.previousElementSibling.hidden=true}setPos(c.lat,c.lng,true)};
$('address').addEventListener('input',function(){this.dataset.touched='1'});
$('find').onclick=function(){var q=$('address').value.trim();if(q.length<4){$('err').hidden=false;$('err').textContent='Type the street and area first, for example "12 Aka Road, Uyo".';return}var b=this;b.textContent='Looking it up…';$('err').hidden=true;fetch('/w/geocode?t='+encodeURIComponent(T)+'&q='+encodeURIComponent(q)).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){b.textContent='Find this address';if(!x.ok){$('err').hidden=false;$('err').textContent=(x.j.error&&x.j.error.message)||'We could not find that address. Add the area or a landmark.';return}setPos(x.j.data.lat,x.j.data.lng);$('found').hidden=false;$('found').textContent='Found: '+x.j.data.formatted+(x.j.data.serviceable?'':' (outside the areas we cover yet)')}).catch(function(){b.textContent='Find this address';$('err').hidden=false;$('err').textContent='No connection. Try again.'})};
$('gps').onclick=function(){if(!navigator.geolocation){$('err').hidden=false;$('err').textContent='Location is not available on this phone. Search or type the address instead.';return}this.textContent='Finding you…';var b=this;navigator.geolocation.getCurrentPosition(function(g){b.textContent='Use my current location';setPos(g.coords.latitude,g.coords.longitude);var acc=Math.round(g.coords.accuracy||0);$('found').hidden=false;$('found').textContent=acc>150?('Your phone placed you within about '+acc+' m. For the exact gate, type the address below and tap Find, or step outside and try again.'):('Located to within about '+acc+' m.')},function(){b.textContent='Use my current location';$('err').hidden=false;$('err').textContent='Could not get your location. Allow location access, or search instead.'},{enableHighAccuracy:true,timeout:10000})};
$('save').onclick=function(){var b=this;if(!pos)return;b.disabled=true;b.textContent='Saving…';$('err').hidden=true;fetch('/w/location',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:T,lat:pos.lat,lng:pos.lng,address:$('address').value,landmark:$('landmark').value})}).then(function(r){return r.json()}).then(function(j){if(j.ok){document.querySelector('main').hidden=true;var m=$('map');if(m)m.hidden=true;$('done').hidden=false;$('doneMsg').textContent=j.message||''}else{b.disabled=false;b.textContent='Save location';$('err').hidden=false;$('err').textContent=(j.error&&j.error.message)||'Could not save. Try again.'}}).catch(function(){b.disabled=false;b.textContent='Save location';$('err').hidden=false;$('err').textContent='Network problem. Try again.'})};
${hasMap ? '' : "$('address').addEventListener('input',function(){$('save').disabled=!pos});"}
`;
  const loader = hasMap
    ? `${script}\n(function(){var s=document.createElement('script');s.src='https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(opts.mapsKey!)}&libraries=places&loading=async&callback=initMap';s.async=true;document.head.appendChild(s)})();`
    : script;
  return shell('Set your location — Kendibo', body, opts.nonce, loader);
}

// ── Matched vendors ───────────────────────────────────────────────────────
export function renderVendorsPage(opts: { token: string; nonce: string; vendors: RankedVendor[]; need: string | null; storefrontBase: string; waNumber?: string; alreadyChosen?: string | null }): string {
  const cards = opts.vendors.map((v) => {
    const badges = [v.badges.identityVerified && 'ID verified', v.badges.faceVerified && 'Selfie matched', v.badges.businessRegistered && 'CAC registered'].filter(Boolean) as string[];
    return `<article class="card">
  <div class="row"><div><h2 style="font-size:17px;margin:0">${esc(v.name)}</h2>
  <p class="note" style="margin:2px 0 0">${v.rating !== null ? `${esc(v.rating.toFixed(1))} · ${esc(v.reviewCount)} review${v.reviewCount === 1 ? '' : 's'}` : 'New on Kendibo'} · ${esc(v.distanceKm < 1 ? '<1' : v.distanceKm.toFixed(1))} km${v.online ? ' · available now' : ''}</p></div></div>
  ${badges.map((b) => `<span class="badge">${esc(b)}</span>`).join('')}
  ${v.reasons.length ? `<ul class="reasons">${v.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
  <form method="post" action="/w/vendors/choose" style="margin-top:14px">
    <input type="hidden" name="t" value="${esc(opts.token)}"><input type="hidden" name="providerId" value="${esc(v.providerId)}">
    <button class="btn primary" type="submit"${opts.alreadyChosen ? ' disabled' : ''}>Choose ${esc(v.name.split(' ')[0])}</button>
  </form>
  ${v.slug ? `<a class="btn ghost" style="margin-top:8px" href="${esc(`${opts.storefrontBase}/s/${v.slug}`)}">See their work</a>` : ''}
</article>`;
  }).join('');
  const body = `
<header><h1>Vendors near you</h1><p>${opts.need ? `For: ${esc(opts.need.slice(0, 90))}` : 'Verified vendors matched to your job'}</p></header>
<main>
  ${opts.alreadyChosen ? '<p class="card" style="background:#EAF6EE;border-color:#cdebd6">You already chose a vendor for this job. We\'ll update you on WhatsApp.</p>' : ''}
  ${cards || '<div class="card"><h2 style="font-size:17px;margin:0 0 6px">No vendors free right now</h2><p class="note">We\'ve kept your request open and will message you on WhatsApp as soon as a verified vendor accepts.</p></div>'}
  ${cards && !opts.alreadyChosen ? `<form method="post" action="/w/vendors/choose"><input type="hidden" name="t" value="${esc(opts.token)}"><input type="hidden" name="providerId" value="auto"><button class="btn ghost" type="submit">Let Kendibo pick the best match</button></form>` : ''}
  <p class="note">Ratings come only from completed Kendibo jobs. You pay through Kendibo, and the vendor is paid after you confirm the job is done.</p>
</main>`;
  return shell('Vendors near you — Kendibo', body, opts.nonce);
}

export function renderMessagePage(opts: { title: string; message: string; nonce: string; waNumber?: string }): string {
  return shell(`${opts.title} — Kendibo`, `<section class="done"><h2>${esc(opts.title)}</h2><p class="note">${esc(opts.message)}</p>${back(opts.waNumber)}</section>`, opts.nonce);
}
