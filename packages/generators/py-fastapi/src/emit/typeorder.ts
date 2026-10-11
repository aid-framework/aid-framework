/**
 * The order types are emitted in, so a generated model never refers forward.
 *
 * Pydantic resolves a string annotation against the module namespace at class
 * creation, so a model that names a class defined below it fails at import with
 * `PydanticUndefinedAnnotation`. Sorting so a struct follows everything it names
 * removes that entire failure mode, and does it without a `model_rebuild()` call
 * that would have to be remembered in every emitted module.
 *
 * The order is a function of the IR alone: at each step the ready type with the
 * lowest id wins, so two runs -- or two machines -- produce the same file.
 */

import type { TypeShape } from '@aid/ir';

import { require } from './require.js';

function dependencies(type: TypeShape, known: Map<string, TypeShape>): string[] {
  const names = new Set<string>();
  for (const field of type.fields) {
    const ref = field.type;
    if (ref.kind === 'named' && known.has(ref.name) && ref.name !== type.id) names.add(ref.name);
  }
  return [...names].sort();
}

export interface TypeOrder {
  readonly ordered: readonly TypeShape[];
  /** Types left over because they take part in a cycle, in id order. */
  readonly cyclic: readonly string[];
}

/**
 * Topologically order structs, dependencies first.
 *
 * The IR's referential gate refuses cyclic types, so `cyclic` is empty for any IR
 * this generator is asked to emit. It still returns the stragglers rather than
 * hanging or throwing: a generator that loops forever on bad input is a worse
 * failure than one that emits a tree a reviewer can see is wrong.
 */
export function typeOrder(types: readonly TypeShape[]): TypeOrder {
  const known = new Map(types.map((type) => [type.id, type]));
  const remaining = new Map(known);
  const satisfied = new Set<string>();
  const ordered: TypeShape[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((type) => dependencies(type, known).every((name) => satisfied.has(name)))
      .map((type) => type.id)
      .sort();
    if (ready.length === 0) break;
    for (const id of ready) {
      const type = require(remaining.get(id), `type '${id}'`);
      ordered.push(type);
      satisfied.add(id);
      remaining.delete(id);
    }
  }

  const cyclic = [...remaining.keys()].sort();
  for (const id of cyclic) ordered.push(require(remaining.get(id), `type '${id}'`));
  return { ordered, cyclic };
}

export function orderedTypes(types: readonly TypeShape[]): readonly TypeShape[] {
  return typeOrder(types).ordered;
}
