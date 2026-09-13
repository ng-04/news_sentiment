// All date-keying is done in IST (UTC+5:30, no DST) since that's the
// timezone the NSE trading calendar and the news actually operate in.
const IST_OFFSET_SECONDS = 19800;

function dateKeyFromMs(ms) {
  const shifted = new Date(ms + IST_OFFSET_SECONDS * 1000);
  return shifted.toISOString().slice(0, 10);
}

export function dateKeyFromUnixSeconds(sec) {
  return dateKeyFromMs(sec * 1000);
}

// rss2json reformats RSS pubDate ("Wed, 09 Sep 2026 04:42:36 GMT") into
// "2026-09-09 04:42:36" — same UTC instant, but with the timezone marker
// stripped. Date.parse on a bare "YYYY-MM-DD HH:MM:SS" string is treated as
// *local* time by JS engines, which would silently shift every headline by
// the viewer's UTC offset, so it must be forced back to UTC explicitly.
export function dateKeyFromPubDate(pubDateStr) {
  let iso = pubDateStr.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) {
    iso = iso.replace(" ", "T") + "Z";
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return dateKeyFromMs(t);
}

export function todayKey() {
  return dateKeyFromMs(Date.now());
}

export function addDaysToKey(dateKey, days) {
  const d = new Date(dateKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
