/**
 * A description from the spec, as a Python docstring.
 *
 * The description is wrapped to the code line budget because `ruff format` does not
 * reflow the contents of a string: an over-long description survives formatting
 * over-long and trips the line budget. The wrap is a real newline inside one literal
 * rather than a run of adjacent literals, because the formatter joins those back
 * together -- and a file the formatter rewrites is a file whose recorded hash changes
 * under the user's feet, so the next `aid gen` would report drift the user did not cause.
 */

import { collapseWhitespace, docstring } from '../python.js';

export function pythonDoc(text: string, indent = ''): string {
  return docstring(collapseWhitespace(text), indent);
}
