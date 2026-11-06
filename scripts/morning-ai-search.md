# Morning AI search — runbook (v3.0)

How the daily morning search for district rates works. This routine is
executed by **hasho's morning job** (a person + AI search), NOT by code
running inside the app: the free container sleeps after ~15 minutes idle,
so nothing inside it can reliably wake up and search at a fixed morning
time. The app's own automatic fetches (AMIS daily-changes + AMIS
ViewPrices) already run on startup and on visits; this routine covers the
districts those two sources do not reach — above all KPK, where no
fetchable daily list exists online.

## 1. When

Every morning, after the AMIS auto-refresh has run (check `/api/live`:
`rates_date` should be today or yesterday). The search itself takes
15–30 minutes for the priority districts below.

## 2. Priority order (KPK + Punjab first, then the rest)

1. **KPK home districts:** Nowshera, Peshawar (already covered — verify
   only), Mardan, Charsadda, Swabi, Kohat, Abbottabad, Haripur, Bannu,
   D.I. Khan, Swat/Mingora, Mansehra.
2. **Punjab districts with no AMIS row yet:** Attock, Bahawalnagar,
   Bhakkar, Chiniot, Jhang, Mandi Bahauddin, Nankana Sahib, Narowal,
   Sheikhupura (and any district whose only row is one potato price).
3. **Then:** Sindh (Hyderabad, Sukkur, Larkana, Mirpurkhas), Balochistan
   (Quetta, Khuzdar, Gwadar), Gilgit-Baltistan, AJK — as time allows.

## 3. Where to search (in this order — official first)

For each district, try in order and stop at the first dated, checkable hit:

1. **The district market committee / District Food Controller's official
   Facebook page** — search Facebook for
   `"<district> sabzi mandi rate list"` / `"<district> نرخنامہ"` /
   `"<district> daily price list"`. District administrations and market
   committees post the day's list as a photo or post almost every morning.
2. **Google search** for the same queries (English + Urdu), e.g.
   `"Nowshera sabzi mandi rates today"`, `"نوشہرہ سبزی منڈی نرخ"`,
   `"Mardan daily price list <date>"`. Prefer results from the district
   administration, a market committee, or a named newspaper (Business
   Recorder, Dawn, Daily Qudrat, UrduPoint) over aggregator sites.
3. **The AMIS ViewPrices database** for that district's markets (already
   automatic — check whether the district appeared there first, so the
   search is not duplicated).
4. **poultryrates.today** for chicken only (KP cities, one item).

### Facebook — the honest limit (read this first)

Facebook is login-walled and actively blocks scrapers. **There is no
Facebook scraper in this app and there must never be one.** This routine
uses only posts a person can open and read in a browser:

- Only use a post that is **publicly visible** (no login needed to see
  the text/photo, or visible from the project's logged-in account).
- The post must carry a **date** (today's date, or "today" with a
  same-day timestamp). An undated photo of a rate list is NOT usable.
- Read the rates **off the post itself** (photo or text). Never copy
  rates from a comment, a shared repost with no source, or a page that
  reposts other districts' lists.
- If the official page did not post today, that district gets **no
  candidate today** — do not fill it from another district's list and
  do not estimate.

## 4. How to extract a candidate

From a usable post, write down per item: item name (English), price,
unit (kg, or dozen for banana), the district, the date on the post, and
the source (page name + post URL). Example:

- Nowshera, 2026-11-06, Tomato Rs 150/kg — source: "Nowshera Sabzi
  Mandi (official Facebook page)", post URL: …

Rules:

- **One row per item.** If the post lists a range (Rs 100–150), take
  the midpoint and note "range midpoint" in the source field.
- **Keep the unit the source uses.** AMIS wholesale is Rs/100kg; a
  market-committee list is usually Rs/kg retail. Record which one it is
  (`kind`: retail or wholesale) — never convert silently. **Dozen
  items (Banana) are the one exception to the Rs/100kg rule:** a dozen
  wholesale price is stored as-is per dozen, never multiplied by 100
  (a Rs 125/dozen Banana stored as 12,500 once showed as Rs 12,500
  per dozen — the QA pass fixed this). So: kg wholesale = Rs/100kg,
  dozen wholesale = Rs per dozen, retail = Rs per unit as listed.
- **Outlier check before proposing:** compare with the nearest district
  that has a rate for the same item (usually the province hub). If the
  new price is below half or above twice the hub's price for that item,
  do NOT propose it as a normal rate — propose it with a note
  ("possible outlier, verify") and let the district admin decide.
- **Never propose a rate from these sources:** daatacenter.com
  (fabricated identical values on every city page), Numbeo (crowd data,
  undated), kfoods.com Quetta (undated, conflicts with PBS), any
  undated PDF, any list older than 2 days, any rate with no source.

## 5. How candidates enter the app (review queue)

Candidates NEVER go straight to the public. They enter as PENDING:

```
POST /api/review/propose
{ "code": "<master ADMIN_CODE>",
  "item": "Tomato", "district": "Nowshera",
  "price": 150, "unit": "kg", "kind": "retail",
  "source": "Nowshera Sabzi Mandi (official Facebook page) <post URL>",
  "date": "2026-11-06" }
```

Then the district admin (or the master) approves or rejects in the
District Admin page / Admin panel review queue:

```
POST /api/review/decide
{ "code": "<master ADMIN_CODE>", "id": 12, "decision": "approve" }
```

- Approve → the row is published with its source and date, and the
  district's page shows it.
- Reject → it never shows. A rejected outlier stays rejected; do not
  re-propose the same value without a new, dated source.

## 6. Daily checklist (copy to the morning job log)

- [ ] `/api/live` — AMIS refresh ran (rates_date today/yesterday)?
- [ ] Priority districts searched (list which ones, in order)?
- [ ] Candidates proposed (item/district/price/source/date)?
- [ ] Queue decided (approved/rejected by whom)?
- [ ] Districts with no usable source today (named, not hidden)?
- [ ] Any outlier held for verification (named)?

## 7. What this routine is NOT

- Not an official government feed. Every rate shows its source and
  date so anyone can verify it; the app never claims to be official.
- Not a scraper. No automated Facebook access, no fake accounts, no
  login-wall circumvention.
- Not a guesser. A district with no dated source today shows its
  province hub's rates, clearly labelled as nearest rates — or nothing.
