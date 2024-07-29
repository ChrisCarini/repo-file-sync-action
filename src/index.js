const core = require('@actions/core')
const fs = require('fs')

const Git = require('./git')
const { forEach, addTrailingSlash, pathIsDirectory, copy, remove, execCmd } = require('./helpers')
const {
	parseConfig,
	PR_LABELS,
	ASSIGNEES,
	TMP_DIR,
	FORK,
	REVIEWERS,
	TEAM_REVIEWERS,
	AUTO_MERGE_MERGE_METHOD,
} = require('./config')
const github = require('@actions/github')

async function syncAndAddFile(git, file, destRepo) {
	const fileExists = fs.existsSync(file.source)
	if (fileExists === false) return core.warning(`Source ${ file.source } not found`)

	const localDestination = `${ destRepo }/${ file.dest }`

	const destExists = fs.existsSync(localDestination)
	if (destExists === true && file.replace === false) return core.warning(`File(s) already exist(s) in destination and 'replace' option is set to false`)

	const isDirectory = await pathIsDirectory(file.source)
	const source = isDirectory ? `${ addTrailingSlash(file.source) }` : file.source
	const dest = isDirectory ? `${ addTrailingSlash(localDestination) }` : localDestination

	if (isDirectory) core.info(`Source is directory`)

	await copy(source, dest, isDirectory, file)

	await git.add(file.dest)
}

async function run() {
	// Reuse octokit for each repo
	const git = new Git()

	const repos = await parseConfig()

	const prUrls = []

	core.startGroup(`START - github.context.payload :`)
	core.debug(JSON.stringify(github.context.payload, null, 2))
	core.endGroup()

	await forEach(repos, async (item) => {
		core.info(`Repository Info`)
		core.info(`Repo Name    : ${ item.repo.name }`)
		core.info(`Repo Owner	: ${ item.repo.user }`)
		core.info(`Repo Branch	: ${ item.repo.branch }`)
		core.info(`Https Url	: https://${ item.repo.fullName }`)
		core.info('	')
		try {
			// Clone and setup the git repository locally
			await git.initRepo(item.repo)

			const SRC_REPO = './'
			const DST_REPO = git.workingDir

			// Determine the branch name we will use
			await git.reservePrBranchName()

			const existingPr = await git.findExistingPr()

			// Create & checkout a branch for the PR
			await git.createPrBranch(existingPr)

			// Set a warning in the PR, if one exists.
			await git.setPrWarning()

			core.info(`Locally syncing file(s) between source and target repository`)

			core.debug(`Force Push:                 ${ github.context.payload?.forced }`)
			core.debug(`Push Commit Length:         ${ github.context.payload?.commits?.length }`)
			let existingPrCommitsLength = existingPr?.commits?.length
			existingPrCommitsLength = existingPrCommitsLength === undefined ? 0 : existingPrCommitsLength
			core.debug(`Existing PR Commits Length: ${ existingPrCommitsLength }`)
			// If the push was forced, or there were multiple commits, deepen the checkouts
			if (github.context.payload?.forced || github.context.payload?.commits?.length > 1) {
				// let fetchDepth = Math.max(existingPrCommitsLength, github.context.payload.commits.length)
				const fetchDepth = existingPrCommitsLength + github.context.payload.commits.length
				await git.deepenCheckout(fetchDepth, SRC_REPO)
				await git.deepenCheckout(fetchDepth, DST_REPO)
			}

			let iterator
			// If the payload was force-pushed, and an there is an existing PR, we can not be certain that
			// all prior commits are the same (e.g. commits may have been re-ordered). Because of this, we
			// go back to the first commit of the source repo, and play back all changes, one by one, from
			// there.
			if (github.context.payload?.forced && existingPr) {
				// (a) get the source repo's 'before reference' that we stored in the PR as a comment.
				// NOTE: We have to store this in the PR, as it's non-trivial to try and connect the
				// commit in the destination repo with the associated commit in the source repo. As
				// such, it's just easier for us to store this info in the PR and extract it if needed.
				const srcRepoBaseCommitSha = git.getSrcRepoBeforeRef()
				core.debug(`srcRepoBaseCommitSha: ${ srcRepoBaseCommitSha }`)

				// (b) get the commits between `(a)..HEAD` for SRC_REPO & build the array of commits
				const commitHashes = await execCmd(`git log --reverse --format='%H' ${ srcRepoBaseCommitSha }..HEAD`, SRC_REPO)
				core.debug(`commit hashes: ${ commitHashes }`)
				const individualCommits = commitHashes?.split('\n')
				core.debug(`individual commit hashes: ${ individualCommits }`)
				iterator = (await Promise.all(individualCommits?.map(async (hash, idx) => {
					core.debug(`processing hash #${ idx }: ${ hash }`)
					return await git.getCommitShaAndMessage(hash, SRC_REPO)
				}))).filter((commit) => commit.sha !== '' && commit.message !== '')

				// (c) reset DST_REPO to the base sha
				await execCmd(
					`git reset --hard ${ existingPr.base.sha }`,
					DST_REPO
				)
			}
			// If the payload was not force-pushed, but contains commits, we simply build the
			// iterator from the payload's commits.
			else if (github.context.payload.commits) {
				iterator = github.context.payload.commits.map((commit) => ({
					sha: commit.id,
					message: commit.message,
				}))
			}
			// Otherwise, we are likely run from `workflow_dispatch` event, so we just grab the
			// current head commit to use.
			else {
				iterator = [ await git.getCommitShaAndMessage('HEAD', SRC_REPO) ]
			}

			core.debug(`iterator: ${ iterator }`)
			core.debug(JSON.stringify(iterator, null, 2))

			const modified = []
			await forEach(iterator, async (commit) => {
				await git.checkout(commit.sha, SRC_REPO, false)

				// Loop through all selected files of the source repo, copying to destination repo
				await forEach(item.files, async (file) => {
					await syncAndAddFile(git, file, DST_REPO)
				})

				// If no changes left and nothing was modified we can assume nothing has changed/needs to be pushed
				if (await git.hasChanges() === false) {
					core.info('File(s) already up to date!')
					await git.removePrWarning()
					return
				}

				// Otherwise, there are still local changes left, so commit them before pushing
				core.debug(`Creating commit`)
				// Change a commit message FROM `foobar (#123)` TO `foobar (https://gh.com/<owner>/<repo>/pull/123)`
				const commitMessage = commit.message.replace(new RegExp('\(#([0-9]+)\)', 'g'), `${ github.context.payload.repository.html_url }/pull/$2`)
				await git.commit(commitMessage)
				modified.push({
					dest: DST_REPO,
					commitMessage: commitMessage,
				})
			})

			if (modified.length === 0) {
				core.info('No specified files needed modification. Complete!')
				return
			}

			core.info(`Pushing changes to target repository`)
			await git.push()

			const commitMessages = []
			if (github.context.payload.forced) {
				core.debug('Using commit messages from commits with modified files only.')
				modified.forEach((commit) => commitMessages.push(commit.commitMessage))
			} else if (existingPr) {
				core.debug('Using commit messages from existing PR + github context payload commits.')
				const { data } = await git.github.pulls.listCommits({
					owner: item.repo.user,
					repo: item.repo.name,
					pull_number: existingPr.number
				})
				data.forEach((commit) => commitMessages.push(commit.commit.message))
				github.context.payload.commits.forEach((commit) => commitMessages.push(commit.message))
			} else {
				core.debug('Using commit messages from github context payload commits.')
				github.context.payload.commits.forEach((commit) => commitMessages.push(commit.message))
			}

			const pullRequest = await git.createOrUpdatePr(commitMessages)

			if (PR_LABELS !== undefined && PR_LABELS.length > 0 && !FORK) {
				core.info(`Adding label(s) "${ PR_LABELS.join(', ') }" to PR`)
				try {
					await git.addPrLabels(PR_LABELS)
				} catch (err) {
					core.warning(`Failed to add label(s) "${ PR_LABELS.join(', ') }" to PR`)
					core.warning(err.message)
				}
			}

			if (ASSIGNEES !== undefined && ASSIGNEES.length > 0 && !FORK) {
				core.info(`Adding assignee(s) "${ ASSIGNEES.join(', ') }" to PR`)
				try {
					await git.addPrAssignees(ASSIGNEES)
				} catch (err) {
					core.warning(`Failed to add assignee(s) "${ ASSIGNEES.join(', ') }" to PR`)
					core.warning(err.message)
				}
			}

			if (REVIEWERS !== undefined && REVIEWERS.length > 0 && !FORK) {
				core.info(`Adding reviewer(s) "${ REVIEWERS.join(', ') }" to PR`)
				try {
					await git.addPrReviewers(REVIEWERS)
				} catch (err) {
					core.warning(`Failed to add reviewer(s) "${ REVIEWERS.join(', ') }" to PR`)
					core.warning(err.message)
				}
			}

			if (TEAM_REVIEWERS !== undefined && TEAM_REVIEWERS.length > 0 && !FORK) {
				core.info(`Adding team reviewer(s) "${ TEAM_REVIEWERS.join(', ') }" to PR`)
				try {
					await git.addPrTeamReviewers(TEAM_REVIEWERS)
				} catch (err) {
					core.warning(`Failed to add team reviewer(s) "${ TEAM_REVIEWERS.join(', ') }" to PR`)
					core.warning(err.message)
				}
			}

			if (AUTO_MERGE_MERGE_METHOD !== undefined) {
				try {
					core.info(`Enabling auto-merge on PR`)
					await git.enablePrAutoMerge(AUTO_MERGE_MERGE_METHOD)
				} catch (err) {
					core.warning(`Failed to enable auto-merge on PR`)
					core.warning(err.message)
				}
			}

			core.notice(`Pull Request #${ pullRequest.number } ${ existingPr ? 'updated' : 'created' }: ${ pullRequest.html_url }`)
			prUrls.push(pullRequest.html_url)

			core.info(`Completed repo: ${ item.repo.name }`)
		} catch (err) {
			core.setFailed(err.message)
			core.debug(err)
		}
	})

	// If we created any PRs, set their URLs as the output
	if (prUrls) {
		core.setOutput('pull_request_urls', prUrls)
	}

	core.debug(`Cleaning up ${ TMP_DIR }`)
	await remove(TMP_DIR)
}

run()
	.then(() => {
	})
	.catch((err) => {
		core.setFailed(err.message)
		core.debug(err)
	})