const { parse } = require('@putout/git-status-porcelain')
const core = require('@actions/core')
const github = require('@actions/github')
const { GitHub, getOctokitOptions } = require('@actions/github/lib/utils')
const { throttling } = require('@octokit/plugin-throttling')
const path = require('path')
const fs = require('fs')
const dedent = require('dedent-js')

const {
	GITHUB_TOKEN,
	IS_INSTALLATION_TOKEN,
	IS_FINE_GRAINED,
	GIT_USERNAME,
	GIT_EMAIL,
	TMP_DIR,
	GITHUB_REPOSITORY,
	OVERWRITE_EXISTING_PR,
	BRANCH_PREFIX,
	FORK,
} = require('./config')

const { execCmd } = require('./helpers')

const GH_RUN_ID = process.env.GITHUB_RUN_ID || 0
const PR_BEING_UPDATED_WARNING = `<div align=center>
    <table>
        <tr>
            <td>
            :warning: :warning: <i><b>Warning:</b> This PR is being updated from within workflow run 
            <a href="https://github.com/${ GITHUB_REPOSITORY }/actions/runs/${ GH_RUN_ID }">#${ GH_RUN_ID }</a>
            ...</i>:warning: :warning:
            </td>
        </tr>
    </table>
</div>`

class Git {
	constructor() {
		const Octokit = GitHub.plugin(throttling)

		const options = getOctokitOptions(GITHUB_TOKEN, {
			throttle: {
				onRateLimit: (retryAfter) => {
					core.debug(`Hit GitHub API rate limit, retrying after ${ retryAfter }s`)
					return true
				},
				onSecondaryRateLimit: (retryAfter) => {
					core.debug(`Hit secondary GitHub API rate limit, retrying after ${ retryAfter }s`)
					return true
				}
			}
		})

		const octokit = new Octokit(options)

		// We need the graphql & rest clients
		this.graphql = octokit.graphql
		this.github = octokit.rest
	}

	async initRepo(repo) {
		// Reset repo specific values
		this.existingPr = undefined
		this.prBranch = undefined
		this.baseBranch = undefined

		// Set values to current repo
		this.repo = repo
		this.workingDir = path.join(TMP_DIR, repo.uniqueName)
		this.gitUrl = `https://${ IS_INSTALLATION_TOKEN ? 'x-access-token:' : '' }${ IS_FINE_GRAINED ? 'oauth:' : '' }${ GITHUB_TOKEN }@${ repo.fullName }.git`

		await this.clone()
		await this.setIdentity()
		this.baseBranch = await this.getBaseBranch(this.workingDir)
		await this.getLastCommitSha()

		if (FORK) {
			const forkUrl = `https://${ GITHUB_TOKEN }@github.com/${ FORK }/${ this.repo.name }.git`
			await this.createFork()
			await this.createRemote(forkUrl)
		}
	}

	async createFork() {
		core.debug(`Creating fork with OWNER: ${ this.repo.user } and REPO: ${ this.repo.name }`)
		await this.github.repos.createFork({
			owner: this.repo.user,
			repo: this.repo.name
		})
	}

	async createRemote(forkUrl) {
		return execCmd(
			`git remote add fork ${ forkUrl }`,
			this.workingDir
		)
	}

	async clone() {
		core.debug(`Cloning ${ this.repo.fullName } into ${ this.workingDir }`)

		return execCmd(
			`git clone --depth 1 ${ this.repo.branch !== 'default' ? '--branch "' + this.repo.branch + '"' : '' } ${ this.gitUrl } ${ this.workingDir }`
		)
	}

	async setIdentity() {
		let username = GIT_USERNAME
		let email = GIT_EMAIL

		if (email === undefined) {
			if (!IS_INSTALLATION_TOKEN) {
				const { data } = await this.github.users.getAuthenticated()
				email = data.email
				username = data.login
				// If email is *STILL* not found (as is the case for myself, with
				// the `Keep my email addresses private` setting), then build the
				// private no-reply GitHub user email alias to use instead.
				if (email === undefined || email === null) {
					email = `${ data.id }+${ data.login }@users.noreply.github.com`
					core.debug(`Email not returned from API. Assuming private email; using: ${ email }`)
				}
			}
		}

		core.debug(`Setting git user to email: ${ email }, username: ${ username }`)

		return execCmd(
			`git config --local user.name "${ username }" && git config --local user.email "${ email }"`,
			this.workingDir
		)
	}

	async getBaseBranch(workingDir) {
		return execCmd(
			`git rev-parse --abbrev-ref HEAD`,
			workingDir
		)
	}

	async reservePrBranchName() {
		const prefix = BRANCH_PREFIX.replace('SOURCE_REPO_NAME', GITHUB_REPOSITORY.split('/')[1])

		let newBranch = path.join(prefix, this.repo.branch).replace(/\\/g, '/').replace(/\/\./g, '/')

		if (OVERWRITE_EXISTING_PR === false) {
			newBranch += `-${ Math.round((new Date()).getTime() / 1000) }`
		}

		core.debug(`Locally reserving PR Branch ${ newBranch }`)

		this.prBranch = newBranch
	}

	async createPrBranch(existingPr) {
		core.debug(`Creating PR Branch ${ this.prBranch }`)

		let checkout_existing_branch = existingPr !== undefined

		if (checkout_existing_branch) {
			await execCmd(
				`git remote set-branches origin "${ this.prBranch }"`,
				this.workingDir
			)
			await execCmd(
				`git fetch --depth 1 origin "${ this.prBranch }"`,
				this.workingDir
			)
		}

		await this.checkout(this.prBranch, this.workingDir, !checkout_existing_branch)
	}

	async add(file) {
		return execCmd(
			`git add -f "${ file }"`,
			this.workingDir
		)
	}

	async getCommitShaAndMessage(ref, workingDir) {
		const commitInfo = await execCmd(`git log -n 1 --format='%H %B' ${ ref }`, workingDir)
		core.debug(`commitInfo for [${ ref }]: ${ commitInfo }`)

		const commitSha = commitInfo.slice(0, 40) // commit SHAs are 40 chars
		const commitMessage = commitInfo.slice(41).trim()
		core.debug(`commitSha: 		${ commitSha }`)
		core.debug(`commitMessage: 	${ commitMessage }`)
		return {
			sha: commitSha,
			message: commitMessage,
		}
	}

	async checkout(ref, workingDir, newBranch = false) {
		return execCmd(
			`git checkout ${ newBranch ? '-b ' : '' }"${ ref }"`,
			workingDir
		)
	}

	async getBlobBase64Content(file) {
		const fileRelativePath = path.join(this.workingDir, file)
		const fileContent = await fs.promises.readFile(fileRelativePath)

		return fileContent.toString('base64')
	}

	async getLastCommitSha() {
		this.lastCommitSha = await execCmd(
			`git rev-parse HEAD`,
			this.workingDir
		)
	}

	async hasChanges() {
		const statusOutput = await execCmd(
			`git status --porcelain`,
			this.workingDir
		)

		return parse(statusOutput).length !== 0
	}

	async commit(message) {
		return execCmd(
			`git commit -m '${ message.replace(/'/g, '\'\\\'\'') }'`,
			this.workingDir
		)
	}

	// Returns a git tree parsed for the specified commit sha
	async getTree(commitSha) {
		const output = await execCmd(
			`git ls-tree -r --full-tree ${ commitSha }`,
			this.workingDir
		)

		const tree = []
		for (const treeObject of output.split('\n')) {
			const [ mode, type, sha ] = treeObject.split(/\s/)
			const file = treeObject.split('\t')[1]

			const treeEntry = {
				mode,
				type,
				sha,
				path: file
			}

			tree.push(treeEntry)
		}

		return tree
	}

	// Creates the blob objects in GitHub for the files that are not in the previous commit only
	async createGithubBlobs(commitSha) {
		core.debug('Creating missing blobs on GitHub')
		const [ previousTree, tree ] = await Promise.all([ this.getTree(`${ commitSha }~1`), this.getTree(commitSha) ])
		const promisesGithubCreateBlobs = []

		for (const treeEntry of tree) {
			// If the current treeEntry are in the previous tree, that means that the blob is uploaded and it doesn't need to be uploaded to GitHub again.
			if (previousTree.findIndex((entry) => entry.sha === treeEntry.sha) !== -1) {
				continue
			}

			const base64Content = await this.getBlobBase64Content(treeEntry.path)

			// Creates the blob. We don't need to store the response because the local sha is the same and we can use it to reference the blob
			const githubCreateBlobRequest = this.github.git.createBlob({
				owner: this.repo.user,
				repo: this.repo.name,
				content: base64Content,
				encoding: 'base64'
			})
			promisesGithubCreateBlobs.push(githubCreateBlobRequest)
		}

		// Wait for all the file uploads to be completed
		await Promise.all(promisesGithubCreateBlobs)
	}

	// Gets the commit list in chronological order
	async getCommitsToPush() {
		const output = await execCmd(
			`git log --format=%H --reverse ${ this.baseBranch }..HEAD`,
			this.workingDir
		)
		return output.split('\n')
	}

	async getCommitMessage(commitSha) {
		return execCmd(
			`git log -1 --format=%B ${ commitSha }`,
			this.workingDir
		)
	}

	// Returns an array of objects with the git tree and the commit, one entry for each pending commit to push
	async getCommitsDataToPush() {
		const commitsToPush = await this.getCommitsToPush()

		const commitsData = []
		for (const commitSha of commitsToPush) {
			const [ commitMessage, tree ] = await Promise.all([ this.getCommitMessage(commitSha), this.getTree(commitSha), this.createGithubBlobs(commitSha) ])
			const commitData = {
				commitMessage,
				tree
			}
			commitsData.push(commitData)
		}
		return commitsData
	}

	// A wrapper for running all the flow to generate all the pending commits using the GitHub API
	async createGithubVerifiedCommits() {
		const commitsData = await this.getCommitsDataToPush()

		// Creates the PR branch if doesn't exists
		try {
			await this.github.git.createRef({
				owner: this.repo.user,
				repo: this.repo.name,
				sha: this.lastCommitSha,
				ref: 'refs/heads/' + this.prBranch
			})

			core.debug(`Created new branch ${ this.prBranch }`)
		} catch (error) {
			// If the branch exists ignores the error
			if (error.message !== 'Reference already exists') throw error
		}

		for (const commitData of commitsData) {
			await this.createGithubTreeAndCommit(commitData.tree, commitData.commitMessage)
		}

		core.debug(`Updating branch ${ this.prBranch } ref`)
		await this.github.git.updateRef({
			owner: this.repo.user,
			repo: this.repo.name,
			ref: `heads/${ this.prBranch }`,
			sha: this.lastCommitSha,
			force: true
		})
		core.debug(`Commit using GitHub API completed`)
	}

	async push() {
		if (FORK) {
			return execCmd(
				`git push -u fork ${ this.prBranch } --force`,
				this.workingDir
			)
		}
		if (IS_INSTALLATION_TOKEN) {
			return await this.createGithubVerifiedCommits()
		}
		return execCmd(
			`git push ${ this.gitUrl } --force`,
			this.workingDir
		)
	}

	async deepenCheckout(depth, workingDir) {
		let output = await execCmd(
			`git fetch --deepen=${ depth }`,
			workingDir,
		)
		core.debug(output)
	}

	async findExistingPr() {
		const { data } = await this.github.pulls.list({
			owner: this.repo.user,
			repo: this.repo.name,
			state: 'open',
			head: `${ FORK ? FORK : this.repo.user }:${ this.prBranch }`
		})

		this.existingPr = data[0]

		if (this.existingPr) {
			core.info(`Found existing PR ${ this.existingPr.number }; fetching commits...`)
			this.existingPr.commits = (await this.github.pulls.listCommits({
				owner: this.repo.user,
				repo: this.repo.name,
				pull_number: this.existingPr.number
			})).data
		}

		core.startGroup('CURRENT PR INFO:')
		core.debug(JSON.stringify(this.existingPr, null, 2))
		core.endGroup()

		return this.existingPr
	}

	async setPrWarning() {
		if (this.existingPr === undefined) {
			return
		}
		core.debug(`Setting PR warning banner on ${ this.repo.user }/${ this.repo.name } PR#${ this.existingPr.number }`)
		await this.github.pulls.update({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			body: dedent(`
				${ PR_BEING_UPDATED_WARNING }

				${ this.existingPr.body }
			`)
		})
	}

	async removePrWarning() {
		if (this.existingPr === undefined) {
			return
		}
		core.debug(`Removing PR warning banner on ${ this.repo.user }/${ this.repo.name } PR#${ this.existingPr.number }`)
		await this.github.pulls.update({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			body: this.existingPr.body.replace(PR_BEING_UPDATED_WARNING, '')
		})
	}

	async createOrUpdatePr(commitMessages) {
		const srcRepoBeforeRef = this.getSrcRepoBeforeRef()
		core.debug(`srcRepoBeforeRef: ${ srcRepoBeforeRef }`)

		console.debug('BEFORE')
		console.debug(JSON.stringify(commitMessages, 2))
		// Change a commit message FROM `foobar (#123)` TO `foobar (https://gh.com/<owner>/<repo>/pull/123)`
		commitMessages = commitMessages.map(commitMessage => {
			return commitMessage
				// Change a commit message FROM `foobar (#123)` TO `foobar (https://gh.com/<owner>/<repo>/pull/123)`
				.replace(new RegExp('\(#([0-9]+)\)', 'g'), `${ github.context.payload.repository.html_url }/pull/$2`)
				// Change a commit message FROM `foobar (https://gh.com/<owner>/<repo>/pull/123)` TO `foobar (<owner>/<repo>/pull/123)`
				.replace('https://github.com/', '')
		})
		console.debug('AFTER')
		console.debug(JSON.stringify(commitMessages, 2))

		// Build the PR title from commit message(s) and list the commit messages in the PR description.
		const title = commitMessages.map((message) => message.split('\n')[0]).join('; ')

		let originalCommitMessages = commitMessages.map((message) => {
			const multiline = message.split('\n')
			if (multiline.length > 1) {
				// We build the return value this way to ensure that none of the lines are indented.
				// Tried using `dedent` methods, however the way we were building the strings needed
				// to deal with parsing a multiline commit message that may have different indent
				// levels that were desired to be preserved. This works, it's not pretty, but works.
				return [
					'<li>',
					'<details>',
					`<summary>${ multiline[0] }</summary>`,
					...multiline.slice(1),
					'</details>',
					'</li>',
				].join('\n')
			}
			return `<li>${ message }</li>`
		}).join('') ?? '_No Source Repo Commit Messages (PR created from manual workflow run)._'

		// We build the body this way to ensure that none of the lines are indented.
		// Tried using `dedent` methods, however we found that sometimes there would
		// still be unnecessary indentation for the first few elements (our 'text'
		// and <details> tags). By building the string this way, we ensure that there
		// is no whitespace before any of the lines we are introducing.
		// This works, it's not pretty, but works.
		const body = [
			`Synced local file(s) with [${ GITHUB_REPOSITORY }](https://github.com/${ GITHUB_REPOSITORY }).`,
			'<details open>',
			'<summary>Source Repo Commit Messages</summary>',
			'<ul>',
			originalCommitMessages,
			'</ul>',
			'</details>',
			`<!-- srcRepoBeforeRef::${ srcRepoBeforeRef } -->`,
			'\n---\n', // horizontal line
			`This PR was ${ this.existingPr ? 'updated' : 'created' } automatically by the [ChrisCarini/repo-file-sync-action](https://github.com/ChrisCarini/repo-file-sync-action) workflow run [#${ process.env.GITHUB_RUN_ID || 0 }](https://github.com/${ GITHUB_REPOSITORY }/actions/runs/${ process.env.GITHUB_RUN_ID || 0 })`,
		].join('\n')

		if (this.existingPr) {
			core.info(`Overwriting existing PR`)

			const { data } = await this.github.pulls.update({
				owner: this.repo.user,
				repo: this.repo.name,
				title: title,
				pull_number: this.existingPr.number,
				body: body,
			})

			return data
		}

		core.info(`Creating new PR`)
		core.debug(`owner: ${ this.repo.user }`)
		core.debug(`repo:  ${ this.repo.name }`)
		core.debug(`title: ${ title }`)
		core.debug(`body:  ${ body }`)
		core.debug(`head:  ${ FORK ? FORK : this.repo.user }:${ this.prBranch }`)
		core.debug(`base:  ${ this.baseBranch }`)
		const { data } = await this.github.pulls.create({
			owner: this.repo.user,
			repo: this.repo.name,
			title: title,
			body: body,
			head: `${ FORK ? FORK : this.repo.user }:${ this.prBranch }`,
			base: this.baseBranch,
		})

		this.existingPr = data

		return data
	}

	async enablePrAutoMerge(mergeMethod) {
		if (!this.existingPr) {
			core.warning(`Unable to enable Auto-Merge on PR; no existing PR found.`)
			return
		}

		if (![ 'MERGE', 'REBASE', 'SQUASH' ].includes(mergeMethod.toUpperCase())) {
			core.error(`AUTO_MERGE_MERGE_METHOD must be one of the following (or not defined): 'MERGE', 'REBASE', or 'SQUASH'.`)
		}

		core.info(`Enabling Auto-Merge on ${ this.repo.user }/${ this.repo.name } PR# ${ this.existingPr.number }`)
		core.debug(`owner:     ${ this.repo.user }`)
		core.debug(`repo:      ${ this.repo.name }`)
		core.debug(`pr_number: ${ this.existingPr.number }`)

		const { repository: { pullRequest: { id: prId } } } = await this.graphql(
			`query GetPullRequestId($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
			  repository(owner: $owner, name: $repo) {
				pullRequest(number: $pullRequestNumber) {
				  id
				}
			  }
			}`,
			{
				owner: this.repo.user,
				repo: this.repo.name,
				pullRequestNumber: this.existingPr.number
			}
		)

		core.debug(`${ this.repo.user }/${ this.repo.name } PR# ${ this.existingPr.number } -> PR ID: ${ prId }`)

		const enablePullRequestAutoMergeResult = await this.graphql(
			`mutation ($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
			  enablePullRequestAutoMerge(input: {
				pullRequestId: $pullRequestId,
				mergeMethod: $mergeMethod
			  }) {
				pullRequest {
				  autoMergeRequest {
					enabledAt
					enabledBy {
					  login
					}
				  }
				}
			  }
			}`,
			{
				pullRequestId: prId,
				mergeMethod: mergeMethod.toUpperCase()
			}
		)

		console.debug(`enablePullRequestAutoMerge on PR ID: ${ prId }:`)
		console.debug(JSON.stringify(enablePullRequestAutoMergeResult, null, 2))
	}

	getSrcRepoBeforeRef() {
		return this.existingPr !== undefined ?
			this.existingPr.body.match(/<!-- srcRepoBeforeRef::(.*) -->/)?.[1] :
			github.context.payload.before
	}

	async addPrLabels(labels) {
		await this.github.issues.addLabels({
			owner: this.repo.user,
			repo: this.repo.name,
			issue_number: this.existingPr.number,
			labels: labels
		})
	}

	async addPrAssignees(assignees) {
		await this.github.issues.addAssignees({
			owner: this.repo.user,
			repo: this.repo.name,
			issue_number: this.existingPr.number,
			assignees: assignees
		})
	}

	async addPrReviewers(reviewers) {
		await this.github.pulls.requestReviewers({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			reviewers: reviewers
		})
	}

	async addPrTeamReviewers(reviewers) {
		await this.github.pulls.requestReviewers({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			team_reviewers: reviewers
		})
	}

	async createGithubTreeAndCommit(tree, commitMessage) {
		core.debug(`Creating a GitHub tree`)
		let treeSha
		try {
			const request = await this.github.git.createTree({
				owner: this.repo.user,
				repo: this.repo.name,
				tree
			})
			treeSha = request.data.sha
		} catch (error) {
			error.message = `Cannot create a new GitHub Tree: ${ error.message }`
			throw error
		}

		core.debug(`Creating a commit for the GitHub tree`)
		const request = await this.github.git.createCommit({
			owner: this.repo.user,
			repo: this.repo.name,
			message: commitMessage,
			parents: [ this.lastCommitSha ],
			tree: treeSha
		})
		this.lastCommitSha = request.data.sha
	}
}

module.exports = Git