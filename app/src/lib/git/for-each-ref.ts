import { git } from './core'
import { GitError } from 'dugite'

import { Repository } from '../../models/repository'
import { Branch, BranchType } from '../../models/branch'
import { CommitIdentity } from '../../models/commit-identity'

/** Get all the branches. */
export async function getBranches(
  repository: Repository,
  ...prefixes: string[]
): Promise<ReadonlyArray<Branch>> {
  const delimiter = '1F'
  const delimiterString = String.fromCharCode(parseInt(delimiter, 16))

  const format = [
    '%(refname)',
    '%(refname:short)',
    '%(upstream:short)',
    '%(objectname)', // SHA
    '%(objectname:short)', // short SHA
    '%(author)',
    '%(committer)',
    '%(symref)',
    `%${delimiter}`, // indicate end-of-line as %(body) may contain newlines
  ].join('%00')

  if (!prefixes || !prefixes.length) {
    prefixes = ['refs/heads', 'refs/remotes']
  }

  // TODO: use expectedErrors here to handle a specific error
  // see https://github.com/desktop/desktop/pull/5299#discussion_r206603442 for
  // discussion about what needs to change
  const result = await git(
    ['for-each-ref', `--format=${format}`, ...prefixes],
    repository.path,
    'getBranches',
    { expectedErrors: new Set([GitError.NotAGitRepository]) }
  )

  if (result.gitError === GitError.NotAGitRepository) {
    return []
  }

  const names = result.stdout
  const lines = names.split(delimiterString)

  // Remove the trailing newline
  lines.splice(-1, 1)

  if (lines.length === 0) {
    return []
  }

  const branches = []

  for (const [ix, line] of lines.entries()) {
    // preceding newline character after first row
    const pieces = (ix > 0 ? line.substr(1) : line).split('\0')

    const ref = pieces[0]
    const name = pieces[1]
    const upstream = pieces[2]
    const sha = pieces[3]
    const shortSha = pieces[4]

    const authorIdentity = pieces[5]
    const author = CommitIdentity.parseIdentity(authorIdentity)

    if (!author) {
      throw new Error(`Couldn't parse author identity for '${shortSha}'`)
    }

    const committerIdentity = pieces[6]
    const committer = CommitIdentity.parseIdentity(committerIdentity)

    if (!committer) {
      throw new Error(`Couldn't parse committer identity for '${shortSha}'`)
    }

    const symref = pieces[7]
    const branchTip = {
      sha,
      author,
    }

    const type = ref.startsWith('refs/head')
      ? BranchType.Local
      : BranchType.Remote

    if (symref.length > 0) {
      // exclude symbolic refs from the branch list
      continue
    }

    branches.push(
      new Branch(name, upstream.length > 0 ? upstream : null, branchTip, type)
    )
  }

  return branches
}

/**
 * Gets all branches that differ from their upstream (i.e. they're ahead,
 * behind or both), excluding the current branch.
 * Useful to narrow down a list of branches that could potentially be fast
 * forwarded.
 *
 * @param repository Repository to get the branches from.
 * @param allBranches All known branches in the repository.
 */
export async function getBranchesDifferingFromUpstream(
  repository: Repository,
  allBranches: ReadonlyArray<Branch>
): Promise<ReadonlyArray<Branch>> {
  const format = [
    '%(refname)',
    '%(refname:short)',
    '%(objectname)', // SHA
    '%(upstream)',
    '%(symref)',
    '%(HEAD)',
  ].join('%00')

  const prefixes = ['refs/heads', 'refs/remotes']

  const result = await git(
    ['for-each-ref', `--format=${format}`, ...prefixes],
    repository.path,
    'getBranchesDifferingFromUpstream',
    { expectedErrors: new Set([GitError.NotAGitRepository]) }
  )

  if (result.gitError === GitError.NotAGitRepository) {
    return []
  }

  const lines = result.stdout.split('\n')

  // Remove the trailing newline
  lines.splice(-1, 1)

  if (lines.length === 0) {
    return []
  }

  const localBranches = []
  const remoteBranchShas = new Map<string, string>()

  // First we need to collect the relevant info from the command output:
  // - For local branches with upstream: name, ref, SHA and the upstream.
  // - For remote branches we only need the sha (and the ref as key).
  for (const line of lines) {
    const [ref, name, sha, upstream, symref, head] = line.split('\0')

    if (symref.length > 0 || head === '*') {
      // Exclude symbolic refs and the current branch
      continue
    }

    if (ref.startsWith('refs/head')) {
      if (upstream.length === 0) {
        // Exclude local branches without upstream
        continue
      }

      localBranches.push({ name, ref, sha, upstream })
    } else {
      remoteBranchShas.set(ref, sha)
    }
  }

  const eligibleBranchNames = new Set<String>()

  // Compare the SHA of every local branch with the SHA of its upstream and
  // collect the names of local branches that differ from their upstream.
  for (const branch of localBranches) {
    const remoteSha = remoteBranchShas.get(branch.upstream)

    if (remoteSha !== undefined && remoteSha !== branch.sha) {
      eligibleBranchNames.add(branch.name)
    }
  }

  if (eligibleBranchNames.size === 0) {
    return []
  }

  // Using the names of those eligible branches, pick the branch objects from
  // all the local branches in the repo.
  return allBranches.filter(
    branch =>
      branch.type === BranchType.Local && eligibleBranchNames.has(branch.name)
  )
}
