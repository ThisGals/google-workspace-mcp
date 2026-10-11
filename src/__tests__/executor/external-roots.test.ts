/**
 * WORKSPACE_EXTRA_ROOTS: the opt-in way out of the one-folder workspace.
 *
 * These use real folders and real symlinks. A mocked filesystem would answer "yes" to the
 * exact questions this code exists to ask ("does this path really stay inside?"), the same
 * way a mocked dispatch layer once hid two methods that never existed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getExtraRoots,
  checkWorkspaceStatus,
  resolveWorkspacePath,
  verifyPathSafety,
  assertNoClobber,
  validateWorkspaceDir,
} from '../../executor/workspace.js';
import { handleWorkspace } from '../../server/handlers/workspace.js';

const EXTERNAL = { external: true } as const;
const canSymlink = process.platform !== 'win32';

let base: string;
let workspace: string;
let clients: string;
let other: string;

const saved = {
  dir: process.env.WORKSPACE_DIR,
  extra: process.env.WORKSPACE_EXTRA_ROOTS,
};

function restoreEnv(): void {
  if (saved.dir !== undefined) process.env.WORKSPACE_DIR = saved.dir; else delete process.env.WORKSPACE_DIR;
  if (saved.extra !== undefined) process.env.WORKSPACE_EXTRA_ROOTS = saved.extra; else delete process.env.WORKSPACE_EXTRA_ROOTS;
}

beforeEach(() => {
  // realpath: on macOS the temp dir is itself a symlink, which would make every
  // containment comparison below fail for a reason that has nothing to do with the code.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ext-')));
  workspace = path.join(base, 'ws');
  clients = path.join(base, 'clients');
  other = path.join(base, 'other');
  for (const d of [workspace, clients, other]) fs.mkdirSync(d);
  process.env.WORKSPACE_DIR = workspace;
  process.env.WORKSPACE_EXTRA_ROOTS = clients;
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('getExtraRoots', () => {
  it('is empty when unset', () => {
    delete process.env.WORKSPACE_EXTRA_ROOTS;
    expect(getExtraRoots()).toEqual({ roots: [], warnings: [] });
  });

  it('keeps an existing folder', () => {
    expect(getExtraRoots()).toEqual({ roots: [clients], warnings: [] });
  });

  it('reads several folders separated by the platform delimiter', () => {
    process.env.WORKSPACE_EXTRA_ROOTS = [clients, other].join(path.delimiter);
    expect(getExtraRoots().roots).toEqual([clients, other]);
  });

  it('drops a folder that does not exist, and says so, rather than creating it', () => {
    const missing = path.join(base, 'typo');
    process.env.WORKSPACE_EXTRA_ROOTS = missing;
    const result = getExtraRoots();
    expect(result.roots).toEqual([]);
    expect(result.warnings[0]).toMatch(/does not exist/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('drops a file that is not a folder', () => {
    const file = path.join(base, 'a-file');
    fs.writeFileSync(file, 'x');
    process.env.WORKSPACE_EXTRA_ROOTS = file;
    expect(getExtraRoots().roots).toEqual([]);
    expect(getExtraRoots().warnings[0]).toMatch(/not a folder/);
  });

  it('drops the home directory and the filesystem root', () => {
    process.env.WORKSPACE_EXTRA_ROOTS = [os.homedir(), path.parse(base).root].join(path.delimiter);
    const result = getExtraRoots();
    expect(result.roots).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('accepts a folder inside a Google Drive mount, but the workspace itself still may not be one', () => {
    const mount = path.join(base, 'My Drive', '!Projects');
    fs.mkdirSync(mount, { recursive: true });
    process.env.WORKSPACE_EXTRA_ROOTS = mount;
    expect(getExtraRoots()).toEqual({ roots: [mount], warnings: [] });
    expect(() => validateWorkspaceDir(mount)).toThrow(/Google Drive mount/);
  });

  it('ignores an unresolved template variable', () => {
    process.env.WORKSPACE_EXTRA_ROOTS = '${user_config.extra_roots}';
    expect(getExtraRoots()).toEqual({ roots: [], warnings: [] });
  });

  it('one bad entry does not take the good one down', () => {
    process.env.WORKSPACE_EXTRA_ROOTS = [path.join(base, 'nope'), clients].join(path.delimiter);
    const result = getExtraRoots();
    expect(result.roots).toEqual([clients]);
    expect(result.warnings).toHaveLength(1);
  });

  it('is reported by checkWorkspaceStatus', () => {
    const status = checkWorkspaceStatus();
    expect(status.valid).toBe(true);
    expect(status.extraRoots).toEqual([clients]);
    expect(status.extraWarnings).toEqual([]);
  });
});

describe('resolveWorkspacePath with external: true', () => {
  it('accepts an absolute path inside an extra folder, unchanged', () => {
    const target = path.join(clients, 'Acme', 'report.pdf');
    expect(resolveWorkspacePath(target, EXTERNAL)).toBe(target);
  });

  it('accepts an absolute path inside the workspace', () => {
    const target = path.join(workspace, 'a.txt');
    expect(resolveWorkspacePath(target, EXTERNAL)).toBe(target);
  });

  it('still treats a relative path as workspace-relative', () => {
    expect(resolveWorkspacePath('reports/q1.csv', EXTERNAL)).toBe(path.join(workspace, 'reports', 'q1.csv'));
  });

  it('refuses an absolute path anywhere else, naming the folders and the fix', () => {
    expect(() => resolveWorkspacePath(path.join(other, 'x.txt'), EXTERNAL)).toThrow(/outside the folders/);
    expect(() => resolveWorkspacePath(path.join(other, 'x.txt'), EXTERNAL)).toThrow(/WORKSPACE_EXTRA_ROOTS/);
  });

  it('refuses .. that climbs out of an extra folder', () => {
    expect(() => resolveWorkspacePath(path.join(clients, '..', 'other', 'x.txt'), EXTERNAL)).toThrow(/outside the folders/);
  });

  it('refuses a sibling that merely shares the folder name as a prefix', () => {
    const evil = path.join(base, 'clients-evil');
    fs.mkdirSync(evil);
    expect(() => resolveWorkspacePath(path.join(evil, 'x.txt'), EXTERNAL)).toThrow(/outside the folders/);
  });

  it('refuses control characters in an absolute path', () => {
    expect(() => resolveWorkspacePath(path.join(clients, 'a\x00b.txt'), EXTERNAL)).toThrow(/control characters/);
  });
});

describe('resolveWorkspacePath WITHOUT external (the default)', () => {
  it('does not reach an extra folder: the path is folded into the workspace as before', () => {
    const resolved = resolveWorkspacePath(path.join(clients, 'a.pdf'));
    expect(resolved.startsWith(workspace + path.sep)).toBe(true);
    expect(resolved.startsWith(clients + path.sep)).toBe(false);
  });
});

describe('verifyPathSafety', () => {
  it('allows an existing file in an extra folder when external', async () => {
    const file = path.join(clients, 'a.txt');
    fs.writeFileSync(file, 'x');
    await expect(verifyPathSafety(file, EXTERNAL)).resolves.toBeUndefined();
  });

  it('refuses the same file when not external', async () => {
    const file = path.join(clients, 'a.txt');
    fs.writeFileSync(file, 'x');
    await expect(verifyPathSafety(file)).rejects.toThrow(/Symlink escape/);
  });

  it('allows a file that does not exist yet, in a subfolder that does not exist yet', async () => {
    await expect(verifyPathSafety(path.join(clients, 'New Client', 'q1', 'a.txt'), EXTERNAL)).resolves.toBeUndefined();
    await expect(verifyPathSafety(path.join(workspace, 'new', 'a.txt'))).resolves.toBeUndefined();
  });

  it('allows a path under a workspace that has not been created yet', async () => {
    fs.rmSync(workspace, { recursive: true });
    await expect(verifyPathSafety(path.join(workspace, 'a.txt'))).resolves.toBeUndefined();
  });

  it.skipIf(!canSymlink)('refuses an existing symlink inside an extra folder that points outside', async () => {
    fs.writeFileSync(path.join(other, 'secret.txt'), 's');
    fs.symlinkSync(path.join(other, 'secret.txt'), path.join(clients, 'link.txt'));
    await expect(verifyPathSafety(path.join(clients, 'link.txt'), EXTERNAL)).rejects.toThrow(/Symlink escape/);
  });

  it.skipIf(!canSymlink)('refuses a NEW file under a symlinked folder that points outside (extra folder)', async () => {
    fs.symlinkSync(other, path.join(clients, 'out'));
    await expect(verifyPathSafety(path.join(clients, 'out', 'new.txt'), EXTERNAL)).rejects.toThrow(/Symlink escape/);
  });

  it.skipIf(!canSymlink)('refuses a NEW file under a symlinked folder that points outside (workspace)', async () => {
    // The pre-existing hole: ENOENT on the file used to end the check before the link was
    // ever looked at.
    fs.symlinkSync(other, path.join(workspace, 'out'));
    await expect(verifyPathSafety(path.join(workspace, 'out', 'new.txt'))).rejects.toThrow(/Symlink escape/);
  });
});

describe('manage_workspace copy', () => {
  it('copies a workspace file into an extra folder', async () => {
    fs.writeFileSync(path.join(workspace, 'inv.txt'), 'hello');
    const dest = path.join(clients, 'Acme', 'inv.txt');

    const res = await handleWorkspace({ operation: 'copy', source: 'inv.txt', destination: dest });

    expect(fs.readFileSync(dest, 'utf-8')).toBe('hello');
    expect(fs.existsSync(path.join(workspace, 'inv.txt'))).toBe(true); // copy, not move
    expect(res.text).toMatch(/Copied/);
  });

  it('copies from an extra folder into the workspace', async () => {
    fs.writeFileSync(path.join(clients, 'brief.txt'), 'brief');
    await handleWorkspace({ operation: 'copy', source: path.join(clients, 'brief.txt'), destination: 'brief.txt' });
    expect(fs.readFileSync(path.join(workspace, 'brief.txt'), 'utf-8')).toBe('brief');
  });

  it('refuses to overwrite unless asked', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'new');
    const dest = path.join(clients, 'a.txt');
    fs.writeFileSync(dest, 'old');

    await expect(handleWorkspace({ operation: 'copy', source: 'a.txt', destination: dest })).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('old');

    await handleWorkspace({ operation: 'copy', source: 'a.txt', destination: dest, overwrite: true });
    expect(fs.readFileSync(dest, 'utf-8')).toBe('new');
  });

  it('refuses a destination outside every approved folder', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');
    await expect(
      handleWorkspace({ operation: 'copy', source: 'a.txt', destination: path.join(other, 'a.txt') }),
    ).rejects.toThrow(/outside the folders/);
    expect(fs.existsSync(path.join(other, 'a.txt'))).toBe(false);
  });

  it('refuses a folder as the source', async () => {
    fs.mkdirSync(path.join(workspace, 'dir'));
    await expect(
      handleWorkspace({ operation: 'copy', source: 'dir', destination: path.join(clients, 'dir') }),
    ).rejects.toThrow(/not a file/);
  });
});

describe('operations that must NOT reach the extra folders', () => {
  it('delete cannot touch a file in an extra folder', async () => {
    const victim = path.join(clients, 'keep.txt');
    fs.writeFileSync(victim, 'precious');
    await expect(handleWorkspace({ operation: 'delete', filename: victim })).rejects.toThrow();
    expect(fs.readFileSync(victim, 'utf-8')).toBe('precious');
  });

  it('move cannot take a file out of, or put one into, an extra folder', async () => {
    const victim = path.join(clients, 'keep.txt');
    fs.writeFileSync(victim, 'precious');
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');

    await expect(handleWorkspace({ operation: 'move', source: victim, destination: 'moved.txt' })).rejects.toThrow();
    expect(fs.existsSync(victim)).toBe(true);

    await handleWorkspace({ operation: 'move', source: 'a.txt', destination: path.join(clients, 'moved.txt') });
    expect(fs.existsSync(path.join(clients, 'moved.txt'))).toBe(false);
  });
});

describe('assertNoClobber', () => {
  it('lets a write into the workspace replace an earlier file', async () => {
    const file = path.join(workspace, 'again.txt');
    fs.writeFileSync(file, 'old');
    await expect(assertNoClobber(file)).resolves.toBeUndefined();
  });

  it('allows a new file in an extra folder', async () => {
    await expect(assertNoClobber(path.join(clients, 'brand-new.pdf'))).resolves.toBeUndefined();
  });

  it('refuses to replace an existing file in an extra folder', async () => {
    const file = path.join(clients, 'theirs.pdf');
    fs.writeFileSync(file, 'precious');
    await expect(assertNoClobber(file)).rejects.toThrow(/never overwritten/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('precious');
  });
});
