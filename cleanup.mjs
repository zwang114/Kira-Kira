import git from 'isomorphic-git';
import fs from 'node:fs';
const dir = process.cwd();
for (const f of ['commit.mjs', 'remote.mjs', 'push.mjs']) {
  await git.remove({ fs, dir, filepath: f });   // untrack, keep on disk
  console.log('untracked:', f);
}
await git.add({ fs, dir, filepath: '.gitignore' });
const sha = await git.commit({
  fs, dir,
  message: `Remove one-off git helper scripts from the repo

These existed only to push from a machine where Apple's \`git\` is gated behind
an unaccepted Xcode license. They are tooling scratch, not part of the app, and
carry no secrets — but they are noise in a repo someone else might read.

Kept on disk and gitignored, so pushing still works here.`,
  author: { name: 'zwang', email: 'zwang@officeofexperience.com' },
});
console.log('commit:', sha.slice(0, 10));
const files = await git.listFiles({ fs, dir, ref: 'main' });
console.log('tracked files now:', files.length);
console.log('helpers still tracked?', files.filter(f => /^(commit|remote|push|gitinit)\.mjs$/.test(f)));
