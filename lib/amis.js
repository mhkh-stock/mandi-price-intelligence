// AMIS "Daily Wholesale Price Commodity Change" parser — no dependencies.
// The live page is an ASP.NET GridView table (id ctl00_cphPage_GridView1)
// with columns: CityName | CropName | Today's FQP/Average Price |
// Yesterday's FQP/Average Price | Change in Price | Price Direction.
// Prices are Rs/100kg unless noted (banana is per dozen, as in the seed).
// The header row repeats between city groups, so it is skipped by name.
// Rows with '-' or non-numeric prices are skipped, never invented.
'use strict';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseNum(s) {
  const t = String(s || '').replace(/,/g, '').trim();
  if (!t || t === '-' || t === '—') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseAmisHtml(html) {
  const text = String(html || '');
  if (/Service is not available/i.test(text)) return { unavailable: true, rows: [] };
  const tableMatch = text.match(/<table[^>]*id="ctl00_cphPage_GridView1"[^>]*>([\s\S]*?)<\/table>/i);
  const scope = tableMatch ? tableMatch[1] : text;
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(scope)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) {
      cells.push(decodeEntities(c[1].replace(/<[^>]+>/g, '')).trim());
    }
    if (cells.length < 4) continue;
    if (cells[0].toLowerCase() === 'cityname') continue; // repeated header row
    const today = parseNum(cells[2]);
    const yesterday = parseNum(cells[3]);
    if (today === null || yesterday === null) continue;
    rows.push({ city: cells[0], crop: cells[1], today, yesterday });
  }
  return { unavailable: false, rows };
}

// Map one AMIS crop name onto the app's items.
// Order: exact match, then parenthetical variant (Ginger(China) -> Ginger +
// variant China), then "X/Y" split (Lady Finger/Okra -> Okra + variant
// Lady Finger), then first-word match (Potato Store -> Potato + Store).
// Anything else is a genuinely new item (unit kg, except Banana -> dozen).
function mapCrop(crop, itemNames) {
  const raw = String(crop || '').trim();
  if (itemNames.includes(raw)) return { item: raw, variant: '', isNew: false };
  const paren = raw.match(/\(([^)]*)\)/);
  const noParen = raw.replace(/\s*\([^)]*\)/g, '').trim();
  if (itemNames.includes(noParen)) {
    return { item: noParen, variant: paren ? paren[1].trim() : '', isNew: false };
  }
  const slash = noParen.split('/');
  if (slash.length > 1) {
    const after = slash[slash.length - 1].trim();
    if (itemNames.includes(after)) {
      return { item: after, variant: slash.slice(0, -1).join('/').trim(), isNew: false };
    }
  }
  const first = noParen.split(/\s+/)[0];
  if (first && itemNames.includes(first)) {
    return { item: first, variant: noParen.slice(first.length).trim(), isNew: false };
  }
  return { item: noParen || raw, variant: '', isNew: true };
}

module.exports = { parseAmisHtml, mapCrop };
