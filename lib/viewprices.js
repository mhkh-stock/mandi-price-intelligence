// AMIS ViewPrices.aspx parser + market mapping — no dependencies.
// The live page is an ASP.NET GridView: one row per market with columns
// Serial | Market | Graph | Min | Max | FQP | Quantity, prices in Rs/100kg
// (1 Quintal = 100 Kg). "-" means no data that day — never invented.
// Commodity header reads e.g. "Commodity: Potato Fresh [ All Prices are in
// Rs/100Kg specified otherwise ]" and the date "Dated:05-11-2026".
// Market names on the site are concatenated spellings (TTSingh, DGKHAN,
// KabirWala, Sraialamgir, TALAGANG, KotAdu, Taunsasharif, MuzafarGhar...),
// so mapping a market to a district needs the verified table below first,
// then an exact district-name match — never a guess. "Noshehrawirkan" is
// Nowshera Virkan (a town in Gujranwala), NOT Nowshera in KPK: it is
// deliberately NOT mapped to Nowshera.
'use strict';

const VIEWPRICES_BASE = 'http://www.amis.pk/ViewPrices.aspx';
function viewPricesUrl(commodityId) {
  return `${VIEWPRICES_BASE}?searchType=0&commodityId=${encodeURIComponent(commodityId)}`;
}

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

// Verified market -> district table (research file §1, potato 05-11-2026).
// Keys are the site's spellings, lowercased, spaces removed.
const MARKET_DISTRICTS = {
  vehari: 'Vehari',
  layyah: 'Layyah',
  ttsingh: 'Toba Tek Singh',
  kabirwala: 'Khanewal',
  arifwala: 'Pakpattan',
  pakpattan: 'Pakpattan',
  lodhran: 'Lodhran',
  mailsi: 'Vehari',
  kahrorpacca: 'Lodhran',
  dunyapur: 'Lodhran',
  dgkhan: 'Dera Ghazi Khan',
  kamalia: 'Toba Tek Singh',
  jahanian: 'Khanewal',
  jampur: 'Rajanpur',
  jhelum: 'Jhelum',
  mianwali: 'Mianwali',
  rajanpur: 'Rajanpur',
  kotadu: 'Muzaffargarh',
  talagang: 'Chakwal',
  abdulhakim: 'Khanewal',
  hafizabad: 'Hafizabad',
  sraialamgir: 'Gujrat',
  pinanwal: 'Jhelum',
  jauharabad: 'Khushab',
  taunsasharif: 'Dera Ghazi Khan',
};

// Spelling variants of district names themselves (same place, site spelling).
const MARKET_ALIASES = {
  rahimyarkhan: 'Rahim Yar Khan',
  mandibahaudin: 'Mandi Bahauddin',
  nankana: 'Nankana Sahib',
  muzafarghar: 'Muzaffargarh',
};

function marketKey(raw) {
  return String(raw || '').replace(/\([^)]*\)/g, '').replace(/[^a-zA-Z]/g, '').toLowerCase();
}
// Map one site market name to a district name, or null when it cannot be
// verified. Order: verified table, spelling aliases, exact district-name
// match. Town names that are not district names stay unmatched on purpose.
function marketToDistrict(raw, districtNames) {
  const key = marketKey(raw);
  if (!key) return null;
  if (MARKET_DISTRICTS[key]) return MARKET_DISTRICTS[key];
  if (MARKET_ALIASES[key]) return MARKET_ALIASES[key];
  const hit = (districtNames || []).find((d) => marketKey(d) === key);
  return hit || null;
}

// Display name of a market: site spelling, parenthetical suffix stripped
// ("Lahore(Singhpura)" -> "Lahore"), trimmed.
function normalizeMarket(raw) {
  return String(raw || '').replace(/\([^)]*\)/g, '').trim();
}

const FRUIT_WORDS = new Set([
  'apple', 'mango', 'banana', 'pomegranate', 'pear', 'melon', 'grapes',
  'orange', 'kinnow', 'guava', 'papaya', 'peach', 'plum', 'apricot',
  'cherry', 'strawberry', 'dates', 'coconut', 'watermelon', 'muskmelon',
  'fig', 'jamun', 'falsa', 'loquat', 'pineapple',
]);
// Category for a newly-seen commodity: fruits by name, chicken is "other",
// everything else defaults to vegetables (the ViewPrices list is
// overwhelmingly vegetables; a wrong default is corrected by an admin).
function guessCategory(itemEn) {
  const name = String(itemEn || '').toLowerCase();
  if (/\bchicken\b/.test(name)) return 'other';
  for (const f of FRUIT_WORDS) {
    if (name.includes(f)) return 'fruits';
  }
  return 'vegetables';
}

// Median of a numeric list (null for an empty list).
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// Outlier rule: with at least 5 markets reporting, a value below half the
// day's median or above twice the median is quarantined, never auto-seeded.
// (Kot Adu potato 3350 and Sarialamgir potato 5100 on 05-11-2026 sit at
// ~29% and ~44% of the ~11,500 median — both trip this rule.)
function isOutlier(fqp, allFqps) {
  const vals = (allFqps || []).filter((v) => Number.isFinite(v));
  if (vals.length < 5) return false;
  const med = median(vals);
  if (!med) return false;
  return fqp < 0.5 * med || fqp > 2 * med;
}

// Parse one ViewPrices page. opts.itemNames (the app's item list) is used
// to tell the commodity dropdown apart from the market dropdown.
// Returns { unavailable, date (ISO or null),
// commodity (name or null), commodities (dropdown enumeration [{id, name}]),
// markets: [{ market, min, max, fqp }] } — only markets with at least one
// of Min/Max/FQP present; "-" rows are dropped, never invented.
function parseViewPricesHtml(html, opts) {
  const text = String(html || '');
  if (/Service is not available/i.test(text)) return { unavailable: true, date: null, commodity: null, commodities: [], markets: [] };
  let date = null;
  const dm = text.match(/Dated:\s*(\d{2})-(\d{2})-(\d{4})/i);
  if (dm) date = `${dm[3]}-${dm[2]}-${dm[1]}`;
  let commodity = null;
  const cm = text.match(/Commodity:\s*([^<\[]+?)\s*(?:\[|<|$)/i);
  if (cm) commodity = cm[1].trim();
  // Commodity dropdown enumeration: the page has (at least) two <select>s —
  // commodities and markets. A select is the commodity select when at
  // least one of its options names a known item (first word match, e.g.
  // "Potato Fresh" -> Potato); market names never match an item, so the
  // market select is excluded wholesale. Options whose text is a verified
  // market are dropped as a second line of defence. Pass { itemNames }
  // (the app's item list) so new commodities still classify the select.
  const itemNames = (opts && opts.itemNames) || [];
  const firstWord = (s) => String(s || '').replace(/\s*\([^)]*\)/g, '').trim().split(/\s+/)[0] || '';
  const looksLikeItem = (text) => {
    const t = String(text || '').replace(/\s*\([^)]*\)/g, '').trim();
    if (itemNames.includes(t)) return true;
    return itemNames.includes(firstWord(t));
  };
  const commodities = [];
  const seen = new Set();
  const selectRe = /<select[^>]*>([\s\S]*?)<\/select>/gi;
  let sel;
  while ((sel = selectRe.exec(text)) !== null) {
    const optsInSelect = [];
    const optRe = /<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/gi;
    let o;
    while ((o = optRe.exec(sel[1])) !== null) {
      optsInSelect.push({ id: Number(o[1]), name: decodeEntities(o[2]).trim() });
    }
    if (!optsInSelect.some((x) => looksLikeItem(x.name))) continue; // market select
    for (const x of optsInSelect) {
      if (!x.id || x.id <= 0 || !x.name || /select/i.test(x.name)) continue;
      if (MARKET_DISTRICTS[marketKey(x.name)] || MARKET_ALIASES[marketKey(x.name)]) continue;
      const key = x.id + '|' + x.name;
      if (seen.has(key)) continue;
      seen.add(key);
      commodities.push(x);
    }
  }
  // Market table: rows whose first cell is a serial number.
  const markets = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(text)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) {
      cells.push(decodeEntities(c[1].replace(/<[^>]+>/g, '')).trim());
    }
    if (cells.length < 6) continue;
    if (!/^\d+$/.test(cells[0])) continue; // header / non-data row
    const market = cells[1];
    if (!market) continue;
    const min = parseNum(cells[3]);
    const max = parseNum(cells[4]);
    const fqp = parseNum(cells[5]);
    if (min === null && max === null && fqp === null) continue; // "-" row
    markets.push({ market, min, max, fqp });
  }
  return { unavailable: false, date, commodity, commodities, markets };
}

module.exports = {
  VIEWPRICES_BASE,
  viewPricesUrl,
  parseViewPricesHtml,
  marketToDistrict,
  normalizeMarket,
  guessCategory,
  isOutlier,
  median,
  MARKET_DISTRICTS,
};
