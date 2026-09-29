#!/usr/bin/env node
// Writes public/staging-notes.json: the latest PRs merged into the current
// branch. Run by deploy.yml on `staging` pushes only, so the /staging-notes
// page has something to show there and nowhere else.
//
// STAGING ONLY: this feature lives on `staging` and must never get a PR into
// main. (Staging is never merged into main wholesale; features reach main
// through their own PRs, so it stays off prod as long as nobody opens one.)
//
// Deliberately NOT "what main is missing": features usually reach main as a
// separate squash-merged PR, so staging's merge commits never become main's
// ancestors and a main..staging diff lists PRs that are already live.
//
//   node scripts/gen-staging-notes.mjs [limit]   (default 60)
//
// Reads GitHub's default merge commit shape:
//   subject "Merge pull request #545 from hookkadev/feat/x", body = PR title.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const limit = process.argv[2] || '60'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

const log = git('log', 'HEAD', '--first-parent', '--merges', '-n', limit,
  '--format=%H%x1f%cI%x1f%s%x1f%b%x1e')

const prs = []
for (const rec of log.split('\x1e')) {
  const [sha, mergedAt, subject, body] = rec.trim().split('\x1f')
  const m = /^Merge pull request #(\d+) from [^/]+\/(.+)$/.exec(subject || '')
  if (!m) continue // "Merge origin/main into staging" etc.
  const title = (body || '').trim().split('\n')[0] || m[2]
  const c = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(title)
  prs.push({
    number: Number(m[1]),
    branch: m[2],
    type: c ? c[1].toLowerCase() : 'other',
    scope: c?.[2] || null,
    title: c ? c[3] : title,
    mergedAt,
    sha: sha.slice(0, 8),
  })
}

const out = {
  generatedAt: new Date().toISOString(),
  commit: git('rev-parse', '--short=8', 'HEAD').trim(),
  prs,
}
writeFileSync(new URL('../public/staging-notes.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`staging-notes.json: ${prs.length} PRs`)
