/**
 * Workspace directory — safe sandbox for file I/O operations.
 *
 * All file operations (Drive upload/download, Docs export, Sheets CSV export)
 * are jailed to this directory. Prevents agents from accidentally operating on
 * home directories, document folders, or Google Drive mount points.
 *
 * EXTRA ROOTS. The workspace is one fixed folder, which is the wrong shape for
 * anyone who files work by client or project. `WORKSPACE_EXTRA_ROOTS` names more
 * folders (separated by `path.delimiter`: `;` on Windows, `:` elsewhere) that the
 * file operations which NEED to reach outside the workspace may use as well.
 *
 * Reaching those folders is opt-in PER CALL SITE, never global. A caller passes
 * `{ external: true }` to resolveWorkspacePath / verifyPathSafety, and today that is
 * only Drive upload / download / export, Gmail attachments, and manage_workspace
 * `copy`. Everything else (delete, move, compress, the scratchpad) still sees the
 * workspace alone. That split is the point: widening the fence for "put this export
 * in the client's folder" must not also widen it for "delete this file".
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { dataDir } from './paths.js';

const DEFAULT_WORKSPACE = path.join(dataDir(), 'workspace');

/** Paths that must never be used as the workspace root. */
const FORBIDDEN_PATHS = [
  // Home directory itself
  () => process.env.HOME ?? '',
  () => process.env.USERPROFILE ?? '',
  // Common document directories (only when HOME/USERPROFILE is set)
  () => process.env.HOME ? path.join(process.env.HOME, 'Documents') : '',
  () => process.env.HOME ? path.join(process.env.HOME, 'Desktop') : '',
  () => process.env.HOME ? path.join(process.env.HOME, 'Downloads') : '',
  // Windows equivalents
  () => process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents') : '',
  () => process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : '',
  () => process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads') : '',
];

/** Path substrings that indicate a Google Drive mount. */
const GDRIVE_PATTERNS = [
  'google-drive',
  'Google Drive',
  'GoogleDrive',
  'gdrive',
  'My Drive',
];

/** Validate and return the workspace directory path. */
export function getWorkspaceDir(): string {
  const configured = process.env.WORKSPACE_DIR;
  // Ignore unresolved mcpb template variables (e.g. "${user_config.workspace_dir}")
  if (configured && !configured.includes('${')) {
    return configured;
  }
  return DEFAULT_WORKSPACE;
}

/**
 * Validate workspace dir is safe. Throws if it IS a protected directory.
 * Being a subdirectory OF a protected directory is fine (e.g. ~/Documents/mcp-workspace/).
 */
export function validateWorkspaceDir(dir: string, options: { allowDriveMount?: boolean } = {}): void {
  const resolved = path.resolve(dir);

  // Must not BE a protected directory (subdirectories are OK)
  for (const getForbidden of FORBIDDEN_PATHS) {
    const forbidden = getForbidden();
    if (forbidden && path.resolve(forbidden) === resolved) {
      throw new Error(
        `Workspace directory cannot be ${resolved} itself — ` +
        `use a subdirectory like ${resolved}/mcp-workspace or ${DEFAULT_WORKSPACE}`,
      );
    }
  }

  // Check for Google Drive mount points. The workspace itself stays strict: it is where
  // files are written, moved and deleted freely, which is exactly what a sync client
  // handles badly. Approved extra folders opt in (allowDriveMount) because they are only
  // written by upload, download, export and a no-overwrite copy, never deleted or moved.
  for (const pattern of options.allowDriveMount ? [] : GDRIVE_PATTERNS) {
    if (resolved.toLowerCase().includes(pattern.toLowerCase())) {
      throw new Error(
        `Workspace directory cannot be inside a Google Drive mount (${resolved}) — ` +
        `this could cause sync conflicts and data loss`,
      );
    }
  }

  // Must not be the filesystem root, or a bare drive root such as F:\ — the old check
  // knew only '/' and 'C:\', so any other drive letter slipped through.
  if (resolved === '/' || resolved === 'C:\\' || path.parse(resolved).root === resolved) {
    throw new Error('Workspace directory cannot be the filesystem root');
  }
}

export interface ExtraRoots {
  /** Extra folders that exist and passed validation. */
  roots: string[];
  /** One line per entry that was dropped, saying why. */
  warnings: string[];
}

/**
 * The extra folders named by WORKSPACE_EXTRA_ROOTS.
 *
 * Each entry gets the same validation as the workspace itself (no home directory, no
 * Documents/Desktop/Downloads, no filesystem or drive root; a Google Drive mount IS allowed here), and
 * must already exist. Existing is deliberate: a mistyped folder must not be quietly
 * created by the first export that targets it. A rejected entry is reported, not fatal;
 * one bad path in the list must not take the whole server down.
 */
export function getExtraRoots(): ExtraRoots {
  const raw = process.env.WORKSPACE_EXTRA_ROOTS;
  // Ignore unresolved mcpb template variables, as WORKSPACE_DIR does.
  if (!raw || raw.includes('${')) return { roots: [], warnings: [] };

  const roots: string[] = [];
  const warnings: string[] = [];

  for (const entry of raw.split(path.delimiter).map((s) => s.trim()).filter(Boolean)) {
    const resolved = path.resolve(entry);
    try {
      validateWorkspaceDir(resolved, { allowDriveMount: true });
      if (!fsSync.statSync(resolved).isDirectory()) {
        throw new Error(`${resolved} is not a folder`);
      }
      if (!roots.includes(resolved)) roots.push(resolved);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      warnings.push(
        code === 'ENOENT'
          ? `Extra folder ${resolved} does not exist, so it was ignored.`
          : `Extra folder ignored: ${(err as Error).message}`,
      );
    }
  }
  return { roots, warnings };
}

export interface WorkspaceStatus {
  path: string;
  valid: boolean;
  warning?: string;
  /** Additional approved folders from WORKSPACE_EXTRA_ROOTS (only those that passed). */
  extraRoots: string[];
  /** Why any WORKSPACE_EXTRA_ROOTS entry was dropped. */
  extraWarnings: string[];
}

/** Check workspace directory status without crashing. */
export function checkWorkspaceStatus(): WorkspaceStatus {
  const dir = getWorkspaceDir();
  const extra = getExtraRoots();
  try {
    validateWorkspaceDir(dir);
    return { path: dir, valid: true, extraRoots: extra.roots, extraWarnings: extra.warnings };
  } catch (err) {
    return {
      path: dir,
      valid: false,
      warning: (err as Error).message,
      extraRoots: extra.roots,
      extraWarnings: extra.warnings,
    };
  }
}

/** Ensure the workspace directory exists and is validated. Returns status instead of throwing. */
export async function ensureWorkspaceDir(): Promise<WorkspaceStatus> {
  const status = checkWorkspaceStatus();
  if (status.valid) {
    await fs.mkdir(status.path, { recursive: true, mode: 0o755 });
  }
  return status;
}

/**
 * Sanitize a single filename segment (no path separators).
 * Strips null bytes, control characters, path separators, and other dangerous chars.
 */
export function sanitizeFilename(filename: string): string {
  return filename
    // Remove null bytes and control characters
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Remove path separators (prevent directory traversal via filename)
    .replace(/[/\\]/g, '_')
    // Remove other potentially dangerous characters
    .replace(/[<>:"|?*]/g, '_')
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Remove leading dots (hidden files) and trailing dots/spaces (Windows)
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    // Fallback if nothing remains
    || 'unnamed';
}

/**
 * Sanitize a path that may contain directory separators.
 * Each segment is sanitized individually; empty and traversal segments are rejected.
 */
export function sanitizePath(inputPath: string): string {
  // Normalize separators to forward slash, then split
  const segments = inputPath.replace(/\\/g, '/').split('/').filter(Boolean);

  if (segments.length === 0) return 'unnamed';

  const sanitized = segments.map(segment => {
    // Reject traversal segments before sanitization
    if (segment === '..' || segment === '.') {
      throw new Error(`Path traversal segment rejected: "${segment}"`);
    }
    return sanitizeFilename(segment);
  });

  return sanitized.join(path.sep);
}

/**
 * Which folders a call may touch.
 *
 * The default is the workspace alone. `external: true` adds the WORKSPACE_EXTRA_ROOTS
 * folders and nothing else, so a call site that has not opted in cannot be widened by
 * configuration.
 */
export interface PathScope {
  external?: boolean;
}

function allowedRoots(scope: PathScope): string[] {
  const workspace = path.resolve(getWorkspaceDir());
  return scope.external ? [workspace, ...getExtraRoots().roots] : [workspace];
}

/**
 * Is `target` the root or inside it? Uses path.relative rather than a string prefix, so
 * it is case-insensitive on Windows (F:\Clients and f:\clients are one folder) and a
 * different drive letter can never look like a child.
 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function outsideMessage(given: string, roots: string[]): string {
  return (
    `"${given}" is outside the folders this server may use (${roots.join(', ')}). ` +
    `To allow another folder, add it to the WORKSPACE_EXTRA_ROOTS environment variable ` +
    `(separate several with "${path.delimiter}") and restart the server.`
  );
}

/**
 * Resolve a file path within the workspace directory.
 * Supports nested paths (e.g. "reports/q1/summary.csv").
 * Prevents path traversal and sanitizes each path segment.
 *
 * With `{ external: true }`, an ABSOLUTE path is also accepted when it lies inside one of
 * the WORKSPACE_EXTRA_ROOTS folders, and is returned as given (resolved). An absolute
 * path anywhere else is refused with a message naming the folders that are allowed. It
 * is NOT quietly folded into the workspace, which is what the sanitizer would otherwise
 * do to it and is how "save to F:\Clients\Acme" came to land in a subfolder nobody
 * looked in. A relative path always means workspace-relative.
 */
export function resolveWorkspacePath(filename: string, scope: PathScope = {}): string {
  if (scope.external && path.isAbsolute(filename)) {
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(filename)) {
      throw new Error('Path contains control characters');
    }
    const resolved = path.resolve(filename);
    const roots = allowedRoots(scope);
    if (!roots.some((root) => isInside(root, resolved))) {
      throw new Error(outsideMessage(filename, roots));
    }
    return resolved;
  }

  const dir = getWorkspaceDir();
  const sanitized = sanitizePath(filename);
  const resolved = path.resolve(dir, sanitized);

  // Ensure the resolved path is still inside the workspace
  const resolvedDir = path.resolve(dir);
  if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
    throw new Error(
      `Path traversal detected: "${filename}" resolves outside workspace directory`,
    );
  }

  return resolved;
}

/**
 * Verify a file path is safe to read/write after symlink resolution.
 * Must be called before any fs operation on a workspace path.
 *
 * A path that does not exist yet (the write case) is judged by its NEAREST EXISTING
 * ANCESTOR. It used to be waved through on ENOENT, so `link/new.txt` passed when `link`
 * was a symlink pointing out of the fence: the check never looked at `link` because it
 * was busy failing to find `new.txt`. Now `link` is resolved and the write is refused.
 */
export async function verifyPathSafety(filePath: string, scope: PathScope = {}): Promise<void> {
  const roots = allowedRoots(scope);
  const realRoots = await Promise.all(
    roots.map((r) => fs.realpath(r).catch(() => r)),
  );

  const start = path.resolve(filePath);
  let probe = start;

  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (realRoots.some((root) => isInside(root, real))) return;
      // An existing ancestor that sits ABOVE a root means the root itself does not exist
      // yet, so there is no link on the way to follow. Not an escape.
      if (probe !== start && realRoots.some((root) => isInside(real, root))) return;
      throw new Error(
        `Symlink escape detected: "${filePath}" resolves to "${real}", ` +
        `outside the allowed folders (${roots.join(', ')})`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return; // reached the top without finding anything: nothing to follow
      probe = parent;
    }
  }
}

/**
 * Refuse to overwrite an existing file that lives OUTSIDE the workspace.
 *
 * Inside the workspace, a download or export replacing an earlier one is ordinary. In an
 * approved extra folder (a client's folder, a synced Drive folder) it would silently
 * replace someone's real file, so those writes must go to a name that is free.
 */
export async function assertNoClobber(filePath: string): Promise<void> {
  const workspace = path.resolve(getWorkspaceDir());
  const target = path.resolve(filePath);
  if (isInside(workspace, target)) return;
  try {
    await fs.stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  throw new Error(
    `${target} already exists. Files outside the workspace are never overwritten; ` +
    'choose a different outputPath, or move the existing file aside yourself.',
  );
}
