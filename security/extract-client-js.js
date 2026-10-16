'use strict';
/**
 * Copies the browser JavaScript of src/*.html into <out>/<name>.html.js so that JS scanners (Semgrep)
 * can parse it: everything outside <script> elements becomes blank, so line numbers match the .html
 * file. Apps Script scriptlets (<?!= ... ?>) and JSON data blocks (<script type="application/json">)
 * are blanked too; they are checked by test/unit/security.test.js instead.
 *
 * Usage: node security/extract-client-js.js <out-dir>
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');

function extract(html) {
  const out = [];
  let inside = false;
  for (const line of html.split('\n')) {
    let i = 0;
    let kept = '';
    while (i < line.length) {
      if (!inside) {
        const m = /<script(\s[^>]*)?>/i.exec(line.slice(i));
        if (!m) break;
        i += m.index + m[0].length;
        inside = !/type\s*=\s*["']application\/json["']/i.test(m[1] || '');
        if (!inside) {
          const end = line.indexOf('</script>', i);
          i = end < 0 ? line.length : end + 9;
        }
      } else {
        const end = line.slice(i).search(/<\/script>/i);
        if (end < 0) { kept += line.slice(i); break; }
        kept += line.slice(i, i + end);
        i += end + 9;
        inside = false;
      }
    }
    out.push(kept.replace(/<\?!?=?[\s\S]*?\?>/g, ''));
  }
  return out.join('\n');
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node security/extract-client-js.js <out-dir>'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.html'))) {
    const js = extract(fs.readFileSync(path.join(SRC, f), 'utf8'));
    if (js.trim()) fs.writeFileSync(path.join(dir, f + '.js'), js);
  }
}

module.exports = { extract };
