// Builds busy.json (booked and closed dates per room) from three places:
//  1. Booking.com calendar feeds (private links in the ICAL_FEEDS secret)
//  2. Innkeep, through a read-only function that returns only room + dates
//  3. blocked.json, an optional list of extra closed dates
const fs = require('fs');
const FEEDS = JSON.parse(process.env.ICAL_FEEDS || '{}');
const INN_URL = (process.env.INNKEEP_URL || '').trim().replace(/\/+$/, '');
const INN_KEY = (process.env.INNKEEP_KEY || '').trim();
const ROOM_IDS = { '302': 'queen-view', '301': 'queen-terrace', '201': 'budget-double', '202': 'budget-twin', '101': 'ground', '102': 'deluxe', '203': 'studio' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const add = (id, a, b) => {
    if (!id || !DATE.test(a) || !DATE.test(b) || b <= a || b <= today) return;
    const list = rooms[id] = rooms[id] || [];
    if (!list.some(x => x[0] === a && x[1] === b)) list.push([a, b]);
  };

  // 1. Booking.com
  for (const id of Object.keys(FEEDS)) {
    rooms[id] = rooms[id] || [];
    try {
      const r = await fetch(FEEDS[id], { headers: { 'User-Agent': 'Mozilla/5.0 (calendar sync)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      parse(await r.text()).forEach(x => add(id, x[0], x[1]));
    } catch (err) {
      failed++; console.log('Booking.com feed failed for ' + id + ': ' + err.message);
      (old[id] || []).forEach(x => add(id, x[0], x[1])); // keep last known dates
    }
  }

  // 2. Innkeep (if it cannot be read, stop and keep the previous busy.json)
  if (INN_URL && INN_KEY) {
    try {
      const r = await fetch(INN_URL + '/rest/v1/rpc/amelie_busy', {
        method: 'POST',
        headers: Object.assign({ apikey: INN_KEY, 'Content-Type': 'application/json' }, INN_KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + INN_KEY } : {}),
        body: '{}'
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const rows = await r.json();
      if (!Array.isArray(rows)) throw new Error('unexpected answer');
      let used = 0;
      rows.forEach(x => { const id = ROOM_IDS[String(x.room).trim()]; if (id) { add(id, x.start_date, x.end_date); used++; } });
      console.log('Innkeep: ' + rows.length + ' rows, ' + used + ' used.');
    } catch (err) {
      console.log('Innkeep failed, keeping the previous busy.json: ' + err.message);
      process.exit(1);
    }
  } else {
    console.log('Innkeep not set up (INNKEEP_URL / INNKEEP_KEY missing), skipping.');
  }

  // 3. Extra closed dates typed by hand
  try {
    const manual = JSON.parse(fs.readFileSync('blocked.json', 'utf8'));
    for (const id of Object.keys(manual)) (Array.isArray(manual[id]) ? manual[id] : []).forEach(x => Array.isArray(x) && add(id, x[0], x[1]));
  } catch (e) { console.log('No usable blocked.json: ' + e.message); }

  Object.keys(rooms).forEach(id => rooms[id].sort());
  if (!Object.keys(rooms).length) { console.log('No data, not writing.'); process.exit(1); }
  fs.writeFileSync('busy.json', JSON.stringify({ rooms }, null, 1) + '\n');
  console.log('Wrote busy.json for ' + Object.keys(rooms).length + ' rooms, ' + failed + ' Booking.com feed(s) failed.');
})();
