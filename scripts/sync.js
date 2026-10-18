// Reads the Booking.com calendar feeds (read-only) and writes busy.json with the blocked dates per room.
// The private feed links come from the ICAL_FEEDS secret, never from this file.
const fs = require('fs');
const FEEDS = JSON.parse(process.env.ICAL_FEEDS || '{}');

function toISO(v) { const m = /(\d{4})(\d{2})(\d{2})/.exec(v || ''); return m ? m[1] + '-' + m[2] + '-' + m[3] : null; }
function parse(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const out = []; const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g; let m;
  while ((m = re.exec(unfolded))) {
    const s = /DTSTART[^:\n]*:([^\r\n]+)/.exec(m[1]); const e = /DTEND[^:\n]*:([^\r\n]+)/.exec(m[1]);
    const a = s && toISO(s[1]); let b = e && toISO(e[1]);
    if (a && !b) { const d = new Date(a + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); b = d.toISOString().slice(0, 10); }
    if (a && b) out.push([a, b]);
  }
  return out;
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  let old = {}; try { old = JSON.parse(fs.readFileSync('busy.json', 'utf8')).rooms || {}; } catch (e) {}
  const rooms = {}; let failed = 0;
  for (const id of Object.keys(FEEDS)) {
    try {
      const r = await fetch(FEEDS[id], { headers: { 'User-Agent': 'Mozilla/5.0 (calendar sync)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      rooms[id] = parse(await r.text()).filter(x => x[1] > today).sort();
    } catch (err) {
      failed++; console.log('Feed failed for ' + id + ': ' + err.message);
      if (old[id]) rooms[id] = old[id]; // keep last known dates
    }
  }
  // Dates you close by hand (listed in blocked.json) are added on top of the Booking.com bookings.
  let manual = {}; try { manual = JSON.parse(fs.readFileSync('blocked.json', 'utf8')); } catch (e) { console.log('No usable blocked.json: ' + e.message); }
  for (const id of Object.keys(manual)) {
    const list = (Array.isArray(manual[id]) ? manual[id] : []).filter(x => Array.isArray(x) && /^\d{4}-\d{2}-\d{2}$/.test(x[0]) && /^\d{4}-\d{2}-\d{2}$/.test(x[1]) && x[1] > x[0] && x[1] > today);
    const seen = new Set((rooms[id] || []).map(x => x.join('|')));
    rooms[id] = (rooms[id] || []).concat(list.filter(x => !seen.has(x.join('|')))).sort();
  }
  if (!Object.keys(rooms).length) { console.log('No data, not writing.'); process.exit(1); }
  fs.writeFileSync('busy.json', JSON.stringify({ rooms }, null, 1) + '\n');
  console.log('Wrote busy.json for ' + Object.keys(rooms).length + ' rooms, ' + failed + ' feed(s) failed.');
})();
