#!/usr/bin/env node
// Writes public/staging-notes.json: every PR merged into the current branch
// that main does not have yet. Run by deploy.yml on `staging` pushes only, so
// the /staging-notes page has something to show there and nowhere else.
//
//   node scripts/gen-staging-notes.mjs [baseRef]   (default origin/main)
//
// Needs full history of both branches (deploy.yml checks out staging with
// fetch-depth 0). Reads GitHub's default merge commit shape:
//   subject "Merge pull request #545 from hookkadev/feat/x", body = PR title.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const base = process.argv[2] || 'origin/main'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

const log = git('log', `${base}..HEAD`, '--first-parent', '--merges',
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
  base,
  prs,
}
writeFileSync(new URL('../public/staging-notes.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`staging-notes.json: ${prs.length} PRs ahead of ${base}`)
