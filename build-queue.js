// Reads prospects.csv, exports phone-only leads to call-queue.csv
// Usage: node build-queue.js <prospects.csv>
const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('usage: node build-queue.js <prospects.csv>'); process.exit(1); }

const rows = fs.readFileSync(path, 'utf8').trim().split('\n').slice(1);
const out = ['business_name,town,region,phone,website'];
let n = 0;
for (const line of rows) {
  const c = line.split(',');
  // loose CSV parse: find phone field by regex on the line
  const m = line.match(/(\+?1?[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4})/);
  const phone = m ? m[1].replace(/\D/g, '') : '';
  const name = c[0].replace(/"/g, '');
  const isDropped = /drop|CLOSED|HIJACKED/i.test(line) && /drop/i.test(c[c.length - 2] || '');
  if (!phone || phone.length < 10 || isDropped) continue;
  out.push(`"${name}","${(c[2]||'').replace(/"/g,'')}","${(c[3]||'').replace(/"/g,'')}","${phone}","${(c[5]||'').replace(/"/g,'')}"`);
  n++;
}
fs.writeFileSync('call-queue.csv', out.join('\n') + '\n');
console.log(`call-queue.csv: ${n} phone-only leads`);
