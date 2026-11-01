/**
 * HCL is written in this package as arrays of plain strings, because that keeps the
 * emitted bytes readable next to the code that decides them.
 *
 * The one cost is interpolation: HCL writes `@{`, substituted here.
 *
 * A plain string containing a dollar-brace is exactly what Biome's
 * `noTemplateCurlyInString` exists to catch -- a suppression per line would be a dozen
 * suppressions all saying "this is HCL, not a template". One substitution says it once.
 */
export function hcl(lines: readonly string[]): string {
  return `${lines.join('\n').replaceAll('@{', '${')}\n`;
}

export interface ModuleFile {
  /** Repository-relative, POSIX-separated. */
  readonly path: string;
  readonly contents: string;
}

/** The module files, in the order a reader opens them: identity, inputs, resources. */
export function moduleFiles(
  dir: string,
  files: { versions: string; variables: string; main: string; outputs: string },
): ModuleFile[] {
  return [
    { path: `${dir}/versions.tf`, contents: files.versions },
    { path: `${dir}/variables.tf`, contents: files.variables },
    { path: `${dir}/main.tf`, contents: files.main },
    { path: `${dir}/outputs.tf`, contents: files.outputs },
  ];
}

/** Whether any service in the plan targets one platform. */
export function targets(
  plan: { services: readonly { target: string }[] },
  target: string,
): boolean {
  return plan.services.some((service) => service.target === target);
}
