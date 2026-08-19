import git from 'isomorphic-git';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.cwd();
const ig = fs.readFileSync('.gitignore','utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
const ignored = (rel) => ig.some(pat => { const p=pat.replace(/\/$/,'');
  return rel===p||rel.startsWith(p+'/')||path.basename(rel)===p||(p.startsWith('*')&&rel.endsWith(p.slice(1))); });
const walk = (d,base='') => fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{
  const rel = base?base+'/'+e.name:e.name;
  if (rel==='.git'||ignored(rel)) return [];
  return e.isDirectory()?walk(path.join(d,e.name),rel):[rel]; });
for (const f of walk(dir)) await git.add({ fs, dir, filepath: f });
const sha = await git.commit({ fs, dir,
  message: `Fix keypad on iOS, gate it on the mask, default to two lines

THE KEYPAD BUG. focus() only opens the iOS keyboard when called synchronously
from a genuine user-gesture handler. The tap focused on 'pointerup' from a
DOCUMENT-level listener — one step removed from the gesture — so every desktop
browser accepted it and iOS silently ignored it: the element focused, no
keyboard appeared. Now focuses from a 'click' handler on the stage itself,
which the UA only synthesises for a real tap. A pointermove threshold still
suppresses drags, since the stage is also a scrub surface.

NO KEYPAD WITH THE MASK OFF. With the stencil off there is no letterform on
screen and the text edits nothing visible, so opening a keyboard over a plain
dithered camera view answers a question the user did not ask. Screen now
mirrors the mask state via a single setMasked() that drives both the utility-bar
icon and the keypad gate, so the two cannot disagree.

Default text is now KIRA / KIRA rather than three lines — measured at 100% of
the grid width and 90% of its height, noticeably larger than the three-line
version, with nothing clipped.

Verified: mask off does not focus, mask on does, a drag does not, and nothing
is focused on load.`,
  author: { name:'zwang', email:'zwang@officeofexperience.com' } });
console.log('commit:', sha.slice(0,10));
