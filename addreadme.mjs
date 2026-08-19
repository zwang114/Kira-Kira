import git from 'isomorphic-git';
import fs from 'node:fs';
const dir = process.cwd();
await git.add({ fs, dir, filepath: 'README.md' });
const sha = await git.commit({
  fs, dir,
  message: 'Add README: what the app is and how to use it',
  author: { name: 'zwang', email: 'zwang@officeofexperience.com' },
});
console.log('commit:', sha.slice(0, 10));
