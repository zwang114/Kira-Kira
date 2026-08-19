import git from 'isomorphic-git';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.cwd();
const ignoreLines = fs.readFileSync('.gitignore','utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
const ignored = (rel) => ignoreLines.some(pat => {
  const p = pat.replace(/\/$/,'');
  return rel===p || rel.startsWith(p+'/') || path.basename(rel)===p || (p.startsWith('*') && rel.endsWith(p.slice(1)));
});
const walk = (d, base='') => fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{
  const rel = base ? base+'/'+e.name : e.name;
  if (rel === '.git' || ignored(rel)) return [];
  return e.isDirectory() ? walk(path.join(d,e.name), rel) : [rel];
});
for (const f of walk(dir)) await git.add({ fs, dir, filepath: f });
const sha = await git.commit({
  fs, dir,
  message: `Typed text mask, replacing the single swipeable letter

The mask was one character chosen by swiping A-Z. It is now typed text: up to
20 characters wrapping across up to 3 lines, upper and lowercase, scaling to
fill a fixed 44x48 grid. Loads showing KIRA / KIRA / KIRA.

Tap the stage to summon the keyboard — deliberately NOT focused on load, so a
phone keyboard never covers the viewfinder before the user asks for it. A
movement threshold separates a tap from a drag, since the stage is still a drag
surface.

The grid keeps its shape rather than growing per line, so the composition holds
at every length and the audio grid stays the size the chime was tuned against.

Descender space is reserved only when the text actually contains g/j/p/q/y.
Reserving unconditionally was measured at a 20% height loss on all-caps text —
a single 'A' rendered 36 rows against 45 — which broke the requirement that one
letter fills the canvas. Keyed on the text rather than per glyph, so every line
shares one scale and the block never reflows between letters.

Verified: single 'A' renders byte-identical to the old single-glyph path (629
ink, 45 rows); gypqj does not clip; tap focuses, drag does not; a 26-character
paste clamps to 20; audio grid, 12-voice cap and chime duration unchanged.`,
  author: { name: 'zwang', email: 'zwang@officeofexperience.com' },
});
console.log('commit:', sha.slice(0,10));
