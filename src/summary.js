import * as core from '@actions/core';

const escapeHtml = (text) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const writePullRequestSummary = async (pullRequests) => {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    core.debug('Skipping job summary because GITHUB_STEP_SUMMARY is not set.');
    return;
  }

  core.summary.addHeading('Repo File Sync Action', 2);

  if (pullRequests.length === 0) {
    core.summary.addRaw('No pull requests were created or updated.', true);
  } else {
    core.summary
      .addRaw(`${pullRequests.length} pull request${pullRequests.length === 1 ? '' : 's'} created or updated.`, true)
      .addTable([
        [
          { data: 'Repository', header: true },
          { data: 'Pull request', header: true },
          { data: 'Title', header: true },
          { data: 'Status', header: true },
        ],
        ...pullRequests.map((pullRequest) => [
          escapeHtml(pullRequest.repository),
          `<a href="${escapeHtml(pullRequest.url)}">#${pullRequest.number}</a>`,
          escapeHtml(pullRequest.title),
          pullRequest.status,
        ]),
      ]);
  }

  try {
    await core.summary.write();
  } catch (err) {
    core.warning(`Failed to write job summary: ${err.message}`);
  }
};

export { writePullRequestSummary };
