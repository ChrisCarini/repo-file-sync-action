import fs from 'fs-extra';
import { readdir } from 'node:fs/promises';
import { exec } from 'child_process';
import * as core from '@actions/core';
import path from 'path';
import nunjucks from 'nunjucks';

nunjucks.configure({ autoescape: true, trimBlocks: true, lstripBlocks: true });

// From https://github.com/toniov/p-iteration/blob/master/lib/static-methods.js - MIT © Antonio V
const forEach = async (array, callback) => {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
};

const execCmd = (command, workingDir, trimResult = true) => {
  core.debug(`EXEC: "${command}" IN ${workingDir}`);
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: workingDir,
        maxBuffer: 1024 * 1024 * 4,
      },
      function (error, stdout) {
        error ? reject(error) : resolve(trimResult ? stdout.trim() : stdout);
      }
    );
  });
};

const addTrailingSlash = (str) => (str.endsWith('/') ? str : `${str}/`);

const pathIsDirectory = async (filePath) => {
  const stat = await fs.lstat(filePath);
  return stat.isDirectory();
};

const listFiles = async (dir) => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
};

const write = async (src, dest, context) => {
  if (typeof context !== 'object') {
    context = {};
  }
  const content = nunjucks.render(src, context);
  await fs.outputFile(dest, content);
};

const copy = async (src, dest, isDirectory, file) => {
  const deleteOrphaned = isDirectory && file.deleteOrphaned;

  const filterFunc = (filePath) => {
    if (file.exclude !== undefined && file.exclude.includes(filePath)) {
      core.debug(`Excluding file ${filePath}`);
      return false;
    }

    return true;
  };

  if (file.template) {
    if (isDirectory) {
      core.debug(`Render all files in directory ${src} to ${dest}`);

      const srcFileList = await listFiles(src);
      for (const srcFile of srcFileList) {
        if (!filterFunc(srcFile)) {
          continue;
        }

        const srcPath = path.join(src, srcFile);
        const destPath = path.join(dest, srcFile);
        await write(srcPath, destPath, file.template);
      }
    } else {
      core.debug(`Render file ${src} to ${dest}`);

      await write(src, dest, file.template);
    }
  } else {
    core.debug(`Copy ${src} to ${dest}`);
    await fs.copy(src, dest, file.exclude !== undefined ? { filter: filterFunc } : {});
  }

  // If it is a directory and deleteOrphaned is enabled - check if there are any files that were removed from source dir and remove them in destination dir
  if (deleteOrphaned) {
    const srcFileList = await listFiles(src);
    const destFileList = await listFiles(dest);

    for (const destFile of destFileList) {
      if (srcFileList.indexOf(destFile) === -1) {
        const filePath = path.join(dest, destFile);
        core.debug(`Found a orphaned file in the target repo - ${filePath}`);

        if (file.exclude !== undefined && file.exclude.includes(path.join(src, destFile))) {
          core.debug(`Excluding file ${destFile}`);
        } else {
          core.debug(`Removing file ${destFile}`);
          await fs.remove(filePath);
        }
      }
    }
  }
};

const remove = async (src) => {
  core.debug(`RM: ${src}`);

  return fs.remove(src);
};

const arrayEquals = (array1, array2) =>
  Array.isArray(array1) &&
  Array.isArray(array2) &&
  array1.length === array2.length &&
  array1.every((value, i) => value === array2[i]);

export { forEach, addTrailingSlash, pathIsDirectory, execCmd, copy, remove, arrayEquals };
