/**
 * The repository-relative POSIX paths every package in this repository speaks, and the
 * one place they become operating-system paths.
 *
 * A plan's paths, a manifest's records and a generator's path helpers are all
 * `app/generated/...`, joined with `/`. They are converted at the filesystem boundary
 * and nowhere else, so no comparison in the CLI can be defeated by a separator.
 */

import { isAbsolute, join, resolve } from 'node:path';

/**
 * The absolute path `posixPath` names under `root`.
 *
 * An absolute path is taken as it is. `aid init --from C:\specs\app.spec.yaml` and
 * `aid validate /srv/app/app.spec.yaml` are ordinary invocations, and joining an absolute
 * path onto the working directory does not fail loudly -- it produces a well-formed path
 * to a file that cannot exist, so the caller reads a "no such file" for a file that is
 * right there.
 */
export function absolutePath(root: string, posixPath: string): string {
  if (posixPath === '') return root;
  if (isAbsolute(posixPath)) return resolve(posixPath);
  return join(root, ...posixPath.split('/'));
}

/** The parent of a repository-relative POSIX path, or `''` for a top-level one. */
export function parentPath(posixPath: string): string {
  const index = posixPath.lastIndexOf('/');
  return index === -1 ? '' : posixPath.slice(0, index);
}
