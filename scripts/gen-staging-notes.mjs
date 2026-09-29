#!/usr/bin/env node
// Writes public/staging-notes.json: the latest merged PRs that carry the
// `staging` label. Run by deploy.yml on `staging` pushes only, so the
// /staging-notes page has something to show there and nowhere else.
//
// STAGING ONLY: this feature lives on `staging` and must never get a PR into
// main. (Staging is never merged into main wholesale; features reach main
// through their own PRs, so it stays off prod as long as nobody opens one.)
//
// The label is the source, not git history: PRs into staging get it (the
// auto-label workflow, #552), and older unlabelled PRs are left out on
// purpose. Needs `gh` with GH_TOKEN set (the Actions runner has both).
//
//   node scripts/gen-staging-notes.mjs [limit]   (default 60)
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const limit = process.argv[2] || '60'

const raw = JSON.parse(execFileSync('gh', ['pr', 'list',
  '--base', 'staging', '--label', 'staging', '--state', 'merged',
  '--limit', limit, '--json', 'number,title,headRefName,mergedAt',
], { encoding: 'utf8' }))

// gh sorts by creation date; the page wants newest merge first.
raw.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))

const prs = raw.map((p) => {
  const c = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(p.title)
  return {
    number: p.number,
    branch: p.headRefName,
    type: c ? c[1].toLowerCase() : 'other',
    scope: c?.[2] || null,
    title: c ? c[3] : p.title,
    mergedAt: p.mergedAt,
  }
})

const out = {
  generatedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim(),
  prs,
}
writeFileSync(new URL('../public/staging-notes.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`staging-notes.json: ${prs.length} PRs`)
