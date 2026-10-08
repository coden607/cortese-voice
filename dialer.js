// Auto-dialer: paces calls from call-queue.csv, skips already-dialed numbers.
// Env: MAX_CALLS (default 6), CALL_GAP_SEC (default 90), SERVER (default http://localhost:8080)
const fs = require('fs');

const SERVER = process.env.SERVER || 'http://localhost:8080';
const MAX = parseInt(process.env.MAX_CALLS || '6', 10);
const GAP = parseInt(process.env.CALL_GAP_SEC || '90', 10) * 1000;

// numbers already having any outcome (from outcomes.jsonl)
const dialed = new Set();
if (fs.existsSync('./outcomes.jsonl')) {
  for (const line of fs.readFileSync('./outcomes.jsonl', 'utf8').split('\n')) {
    try { const j = JSON.parse(line); if (j.to) dialed.add(j.to.replace(/\D/g, '')); } catch {}
  }
}

const queue = fs.readFileSync('call-queue.csv', 'utf8').trim().split('\n').slice(1)
  .map(l => { const m = l.match(/"(.*?)","(.*?)","(.*?)","(\d+)"/); return m ? { name: m[1], town: m[2], phone: m[4] } : null; })
  .filter(Boolean)
  .filter(q => !dialed.has(q.phone));

console.log(`${queue.length} undialed leads in queue (pacing: ${MAX}/run, ${GAP/1000}s gap)`);

(async () => {
  let sent = 0;
  for (const q of queue) {
    if (sent >= MAX) break;
    const to = '+1' + q.phone;
    try {
      const r = await fetch(SERVER + '/call', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'to=' + encodeURIComponent(to) });
      const j = await r.json();
      console.log(`DIAL ${q.name} (${q.town}) → ${to} :: ${j.sid || j.error}`);
    } catch (e) { console.log(`FAIL ${q.name}: ${e.message}`); }
    sent++;
    if (sent < MAX) await new Promise(r => setTimeout(r, GAP));
  }
  console.log(`dialer done: ${sent} calls fired`);
})();
