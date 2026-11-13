/**
 * The repository-relative POSIX paths every package in this repository speaks, and the
 * one place they become operating-system paths.
 *
 * A plan's paths, a manifest's records and a generator's path helpers are all
 * `app/generated/...`, joined with `/`. They are converted at the filesystem boundary
 * and nowhere else, so no comparison in the CLI can be defeated by a separator.
 */

import { isAbsolute, join, posix, resolve } from 'node:path';

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

/**
 * A path a person typed, as the repository-relative POSIX path this package speaks.
 *
 * `parentPath` above splits on `/` because that is the only separator a path in this
 * package is allowed to contain, and keeping it that strict is what makes an artifact path
 * compare equal on a laptop and in CI. The strictness is affordable only because a typed
 * path is converted once, here, at the point where a command reads its argument:
 * `aid resolve customers\acme.yaml` and `aid resolve customers/acme.yaml` name the same
 * overlay, and without this conversion the first one looks like a top-level file whose
 * base has moved, so a document that resolves correctly is refused with
 * `overlay/base-missing` and a hint to check a path that is already right.
 *
 * `.` and `..` are resolved as well, because `./customers/acme.yaml` and
 * `customers/../customers/acme.yaml` are the same file and the artifact path derived from
 * them should not depend on how the caller spelled it.
 *
 * An absolute path is left for {@link absolutePath} to recognise: `C:\specs\a.yaml` becomes
 * `C:/specs/a.yaml`, which `isAbsolute` still rejects on POSIX and still accepts on Windows,
 * which is the answer each platform wants.
 */
export function repoPath(typed: string): string {
  const unified = typed.replace(/\\/g, '/');
  return unified === '' ? '' : posix.normalize(unified);
}
