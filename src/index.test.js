import { beforeEach, expect, jest, test } from '@jest/globals';

const core = {
  debug: jest.fn(),
  endGroup: jest.fn(),
  info: jest.fn(),
  notice: jest.fn(),
  setFailed: jest.fn(),
  setOutput: jest.fn(),
  startGroup: jest.fn(),
  warning: jest.fn(),
};
const git = {
  workingDir: 'tmp-sync/destination',
  initRepo: jest.fn(),
  reservePrBranchName: jest.fn(),
  findExistingPr: jest.fn(),
  createPrBranch: jest.fn(),
  setPrWarning: jest.fn(),
  removePrWarning: jest.fn(),
  checkout: jest.fn(),
  hasChanges: jest.fn(),
  commit: jest.fn(),
  push: jest.fn(),
  createOrUpdatePr: jest.fn(),
  addPrLabels: jest.fn(),
  github: { pulls: { listCommits: jest.fn() } },
};
const parseConfig = jest.fn();
const remove = jest.fn();
const writePullRequestSummary = jest.fn();

jest.unstable_mockModule('@actions/core', () => core);
jest.unstable_mockModule('@actions/github', () => ({
  context: {
    payload: {
      commits: [{ id: 'abc123', message: 'Sync workflows' }],
      repository: { html_url: 'https://github.com/owner/source' },
    },
  },
}));
jest.unstable_mockModule('./git.js', () => ({
  default: jest.fn().mockImplementation(() => git),
}));
jest.unstable_mockModule('./config.js', () => ({
  parseConfig,
  PR_LABELS: ['sync'],
  ASSIGNEES: [],
  TMP_DIR: 'tmp-sync',
  FORK: false,
  REVIEWERS: [],
  TEAM_REVIEWERS: [],
  AUTO_MERGE_MERGE_METHOD: undefined,
}));
jest.unstable_mockModule('./helpers.js', () => ({
  forEach: async (items, callback) => {
    for (const item of items) {
      await callback(item);
    }
  },
  addTrailingSlash: jest.fn(),
  pathIsDirectory: jest.fn(),
  copy: jest.fn(),
  remove,
  execCmd: jest.fn(),
}));
jest.unstable_mockModule('./summary.js', () => ({ writePullRequestSummary }));

const repositories = [
  {
    repo: { user: 'owner', name: 'first', branch: 'main', fullName: 'github.com/owner/first' },
    files: [],
  },
  {
    repo: { user: 'owner', name: 'second', branch: 'main', fullName: 'github.com/owner/second' },
    files: [],
  },
];
const pullRequest = {
  number: 42,
  title: 'Sync workflows',
  html_url: 'https://github.com/owner/first/pull/42',
};
const summaryEntry = {
  repository: 'owner/first',
  number: 42,
  title: 'Sync workflows',
  url: 'https://github.com/owner/first/pull/42',
  status: 'Created',
};

const runAction = async () => {
  const summaryWritten = new Promise((resolve) => {
    writePullRequestSummary.mockImplementation(async (pullRequests) => {
      resolve(pullRequests);
    });
  });
  await import('./index.js');
  return summaryWritten;
};

beforeEach(() => {
  jest.resetModules();
  jest.resetAllMocks();
  parseConfig.mockResolvedValue([repositories[0]]);
  git.hasChanges.mockResolvedValue(true);
  git.createOrUpdatePr.mockResolvedValue(pullRequest);
  git.github.pulls.listCommits.mockResolvedValue({ data: [] });
});

test('summarizes created and updated PRs while preserving the URL array output', async () => {
  parseConfig.mockResolvedValue(repositories);
  git.findExistingPr.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ number: 7, commits: [] });
  git.createOrUpdatePr.mockResolvedValueOnce(pullRequest).mockResolvedValueOnce({
    number: 7,
    title: 'Sync workflows',
    html_url: 'https://github.com/owner/second/pull/7',
  });

  expect(await runAction()).toEqual([
    summaryEntry,
    {
      repository: 'owner/second',
      number: 7,
      title: 'Sync workflows',
      url: 'https://github.com/owner/second/pull/7',
      status: 'Updated',
    },
  ]);
  expect(core.setOutput).toHaveBeenCalledWith('pull_request_urls', [
    pullRequest.html_url,
    'https://github.com/owner/second/pull/7',
  ]);
  expect(writePullRequestSummary).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith('tmp-sync');
  expect(core.setFailed).not.toHaveBeenCalled();
});

test('reports no PRs when files are already up to date, even if an open PR exists', async () => {
  git.findExistingPr.mockResolvedValue({ number: 42, commits: [] });
  git.hasChanges.mockResolvedValue(false);

  expect(await runAction()).toEqual([]);
  expect(git.createOrUpdatePr).not.toHaveBeenCalled();
  expect(core.setOutput).toHaveBeenCalledWith('pull_request_urls', []);
  expect(core.setFailed).not.toHaveBeenCalled();
});

test('retains successful PRs when another repository fails to sync', async () => {
  parseConfig.mockResolvedValue(repositories);
  git.initRepo.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Repository unavailable'));

  expect(await runAction()).toEqual([summaryEntry]);
  expect(core.setOutput).toHaveBeenCalledWith('pull_request_urls', [pullRequest.html_url]);
  expect(core.setFailed).toHaveBeenCalledWith('Repository unavailable');
});

test('does not list a PR whose creation failed', async () => {
  git.createOrUpdatePr.mockRejectedValue(new Error('PR creation failed'));

  expect(await runAction()).toEqual([]);
  expect(core.setOutput).toHaveBeenCalledWith('pull_request_urls', []);
  expect(core.setFailed).toHaveBeenCalledWith('PR creation failed');
});

test('retains a created PR when adding its labels fails', async () => {
  git.addPrLabels.mockRejectedValue(new Error('Label unavailable'));

  expect(await runAction()).toEqual([summaryEntry]);
  expect(core.warning).toHaveBeenCalledWith('Label unavailable');
  expect(core.setFailed).not.toHaveBeenCalled();
});

test('still writes the summary if cleanup fails', async () => {
  remove.mockRejectedValue(new Error('Cleanup failed'));

  expect(await runAction()).toEqual([summaryEntry]);
  expect(core.setFailed).toHaveBeenCalledWith('Cleanup failed');
  expect(writePullRequestSummary).toHaveBeenCalledTimes(1);
});

test('writes an empty summary if configuration cannot be read', async () => {
  parseConfig.mockRejectedValue(new Error('Invalid configuration'));

  expect(await runAction()).toEqual([]);
  expect(git.initRepo).not.toHaveBeenCalled();
  expect(core.setFailed).toHaveBeenCalledWith('Invalid configuration');
});
