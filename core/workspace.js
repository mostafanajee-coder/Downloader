'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Where a download is physically assembled before it becomes a real file in
 * the user's folder.
 *
 * IDM assembles every download inside its own work area
 * (%AppData%\IDM\DwnlData\<user>\<id>_0\) and only publishes the finished file
 * to the destination. That matters for more than tidiness: a half-written movie
 * sitting in the Video folder gets indexed by Windows Search, picked up by
 * Plex, synced by OneDrive, and looks to the user like a finished download that
 * simply refuses to play. Publishing only on success means the destination
 * either holds a complete file or holds nothing.
 *
 * The working directory is derived from a stable hash of the destination path,
 * so a resumed download finds the same partial file and the same .ddl.json
 * sidecar on its next run. (Changing tempDir between runs therefore orphans an
 * in-progress download's scratch data — it restarts rather than resumes.)
 */

function workspaceKey(destPath) {
  return crypto.createHash('sha1').update(path.resolve(destPath)).digest('hex').slice(0, 16);
}

/**
 * Decide where to assemble `destPath`.
 *
 * Returns `{ workPath, workDir, usingTemp }`. When no temp folder is configured
 * — or it turns out to be missing, read-only, or otherwise unusable — this
 * degrades to assembling next to the destination, which is what the engine did
 * before temp folders existed. A broken temp folder must never be the reason a
 * download can't start.
 */
function resolveWorkspace({ destPath, tempDir }) {
  const inPlace = {
    workPath: destPath,
    workDir: path.dirname(destPath),
    usingTemp: false,
  };
  if (!destPath || !tempDir) return inPlace;

  try {
    const workDir = path.join(tempDir, workspaceKey(destPath));
    fs.mkdirSync(workDir, { recursive: true });
    fs.accessSync(workDir, fs.constants.W_OK);
    return { workPath: path.join(workDir, path.basename(destPath)), workDir, usingTemp: true };
  } catch (err) {
    return inPlace;
  }
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // Best effort. A locked handle here must not turn a finished download into
    // a reported failure; the worst case is scratch data left behind.
  }
}

/**
 * Publish a finished assembly to its destination and tear the scratch area
 * down. Safe to call when the download was assembled in place — it just
 * returns.
 */
function finalizeWorkspace({ workPath, destPath, workDir, usingTemp }) {
  if (!usingTemp || path.resolve(workPath) === path.resolve(destPath)) return destPath;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // An existing file at the destination is replaced: the download was aimed
  // there deliberately, and this matches what writing in place always did.
  try {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  } catch (err) {
    // If it can't be removed the rename below will report the real problem.
  }

  try {
    fs.renameSync(workPath, destPath);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // The temp folder is on a different volume than the destination, and a
    // rename cannot cross that boundary. Copy, verify the length, then drop
    // the source — a truncated copy must not be mistaken for a finished file.
    fs.copyFileSync(workPath, destPath);
    const copied = fs.statSync(destPath).size;
    const original = fs.statSync(workPath).size;
    if (copied !== original) {
      throw new Error(`Copy to the destination is ${copied} bytes but the assembled file is ${original}.`);
    }
    fs.unlinkSync(workPath);
  }

  removeDir(workDir);
  return destPath;
}

/**
 * Throw away a download's scratch area entirely. Used when an item is deleted
 * from the queue, so abandoned partial downloads don't accumulate in the temp
 * folder forever.
 */
function discardWorkspace({ destPath, tempDir }) {
  if (!destPath || !tempDir) return;
  removeDir(path.join(tempDir, workspaceKey(destPath)));
}

module.exports = { resolveWorkspace, finalizeWorkspace, discardWorkspace, workspaceKey };
