import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from '@jest/globals';
import core from '@actions/core';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { EOL, tmpdir } from 'node:os';
import path from 'node:path';

const warning = jest.fn();
const debug = jest.fn();

jest.unstable_mockModule('@actions/core', () => ({ ...core, warning, debug }));

const { writePullRequestSummary } = await import('./summary.js');

const pullRequest = {
  repository: 'owner/repository',
  number: 42,
  title: 'Sync workflows',
  url: 'https://github.com/owner/repository/pull/42',
  status: 'Created',
};

const originalSummaryPath = process.env.GITHUB_STEP_SUMMARY;
let directory;
let summaryPath;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'repo-file-sync-summary-'));
  summaryPath = path.join(directory, 'summary.md');
});

beforeEach(async () => {
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  await writeFile(summaryPath, '');
  core.summary.emptyBuffer();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  if (originalSummaryPath === undefined) {
    delete process.env.GITHUB_STEP_SUMMARY;
  } else {
    process.env.GITHUB_STEP_SUMMARY = originalSummaryPath;
  }
  await rm(summaryPath);
  await rmdir(directory);
});

test('appends a table containing links, titles, repositories, and creation/update status', async () => {
  await writeFile(summaryPath, `Existing summary${EOL}`);

  await writePullRequestSummary([
    pullRequest,
    {
      repository: 'owner/another-repository',
      number: 7,
      title: 'Sync configuration',
      url: 'https://github.example.com/owner/another-repository/pull/7',
      status: 'Updated',
    },
  ]);

  expect(await readFile(summaryPath, 'utf8')).toBe(
    [
      `Existing summary${EOL}`,
      `<h2>Repo File Sync Action</h2>${EOL}`,
      `2 pull requests created or updated.${EOL}`,
      '<table><tr><th>Repository</th><th>Pull request</th><th>Title</th><th>Status</th></tr>',
      '<tr><td>owner/repository</td>',
      '<td><a href="https://github.com/owner/repository/pull/42">#42</a></td>',
      '<td>Sync workflows</td><td>Created</td></tr>',
      '<tr><td>owner/another-repository</td>',
      '<td><a href="https://github.example.com/owner/another-repository/pull/7">#7</a></td>',
      '<td>Sync configuration</td><td>Updated</td></tr>',
      `</table>${EOL}`,
    ].join('')
  );
  expect(core.summary.isEmptyBuffer()).toBe(true);
});

test('uses singular wording for one pull request', async () => {
  await writePullRequestSummary([pullRequest]);

  expect(await readFile(summaryPath, 'utf8')).toContain(`1 pull request created or updated.${EOL}`);
});

test('writes an explicit empty state when no pull requests were created or updated', async () => {
  await writePullRequestSummary([]);

  expect(await readFile(summaryPath, 'utf8')).toBe(
    `<h2>Repo File Sync Action</h2>${EOL}No pull requests were created or updated.${EOL}`
  );
});

test('escapes HTML in repository names, PR titles, and link attributes', async () => {
  await writePullRequestSummary([
    {
      ...pullRequest,
      repository: 'owner/<repository>',
      title: 'Sync <script>alert("test")</script> & \'quotes\' | [markdown]',
      url: 'https://github.com/owner/repository/pull/42?foo="bar"&value=<test>',
    },
  ]);

  const summary = await readFile(summaryPath, 'utf8');
  expect(summary).toContain('<td>owner/&lt;repository&gt;</td>');
  expect(summary).toContain(
    '<td>Sync &lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt; &amp; &#39;quotes&#39; | [markdown]</td>'
  );
  expect(summary).toContain(
    '<a href="https://github.com/owner/repository/pull/42?foo=&quot;bar&quot;&amp;value=&lt;test&gt;">#42</a>'
  );
});

test('skips writing outside a runtime that provides a job summary', async () => {
  delete process.env.GITHUB_STEP_SUMMARY;

  await writePullRequestSummary([pullRequest]);

  expect(await readFile(summaryPath, 'utf8')).toBe('');
  expect(core.summary.isEmptyBuffer()).toBe(true);
  expect(debug).toHaveBeenCalledWith('Skipping job summary because GITHUB_STEP_SUMMARY is not set.');
});

test('warns about summary write failures without failing the sync', async () => {
  jest.spyOn(core.summary, 'write').mockRejectedValue(new Error('Disk full'));

  await expect(writePullRequestSummary([pullRequest])).resolves.toBeUndefined();

  expect(warning).toHaveBeenCalledWith('Failed to write job summary: Disk full');
});
