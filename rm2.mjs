import git from 'isomorphic-git';
import fs from 'node:fs';
const dir = process.cwd();
for (const f of ['addreadme.mjs','cleanup.mjs','commit2.mjs']) {
  await git.remove({ fs, dir, filepath: f });
}
await git.add({ fs, dir, filepath: '.gitignore' });
const sha = await git.commit({ fs, dir,
  message: 'Untrack the remaining git helper scripts\n\nSame reason as before: one-off tooling for pushing from a machine where\nApple’s git is licence-gated. Kept on disk, gitignored.',
  author: { name: 'zwang', email: 'zwang@officeofexperience.com' } });
console.log('commit:', sha.slice(0,10));
