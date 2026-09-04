/**
 * Defensive views over native Canvas element objects.
 *
 * Obsidian exposes selections and scene entries through private runtime
 * objects, while JSON Canvas stores plain node/edge records.  M1 features only
 * need stable IDs, basic type/file fields, and (for presentation) the owning
 * DOM element.  Keeping that probing here prevents feature modules from
 * guessing private fields independently.
 */

type UnknownRecord = Record<PropertyKey, unknown>;

const MAX_ELEMENT_ID_LENGTH = 512;
const MAX_SELECTION_ITEMS = 100_000;
const INVALID_ID_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isObject(value: unknown): value is UnknownRecord {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function safeGet(target: unknown, key: PropertyKey): unknown {
  if (!isObject(target)) {
    return undefined;
  }
  try {
    return Reflect.get(target, key, target);
  } catch {
    return undefined;
  }
}

function safeCall(target: unknown, method: PropertyKey): unknown {
  const callback = safeGet(target, method);
  if (typeof callback !== "function") {
    return undefined;
  }
  try {
    return Reflect.apply(callback, target, []);
  } catch {
    return undefined;
  }
}

function asStableId(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ELEMENT_ID_LENGTH ||
    value.trim() !== value ||
    INVALID_ID_CHARACTERS.test(value)
  ) {
    return undefined;
  }
  return value;
}

function elementData(value: unknown): unknown {
  const direct = safeGet(value, "data");
  if (isObject(direct)) {
    return direct;
  }
  const fromMethod = safeCall(value, "getData");
  return isObject(fromMethod) ? fromMethod : undefined;
}

export function readCanvasElementId(value: unknown): string | undefined {
  return asStableId(safeGet(value, "id")) ?? asStableId(safeGet(elementData(value), "id"));
}

export function readCanvasElementType(value: unknown): string | undefined {
  const direct = safeGet(value, "type");
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const nested = safeGet(elementData(value), "type");
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

export function readCanvasElementFile(value: unknown): string | undefined {
  const direct = safeGet(value, "file");
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const nested = safeGet(elementData(value), "file");
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

export function readCanvasElementDom(value: unknown): HTMLElement | undefined {
  for (const key of ["nodeEl", "containerEl", "contentEl", "el"] as const) {
    const candidate = safeGet(value, key);
    if (typeof HTMLElement !== "undefined" && candidate instanceof HTMLElement) {
      return candidate;
    }
  }
  return undefined;
}

/** Collect unique stable IDs without trusting a collection's iterator. */
export function collectCanvasElementIds(values: unknown): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    const id = readCanvasElementId(value);
    if (id !== undefined && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  };

  let isArray = false;
  try {
    isArray = Array.isArray(values);
  } catch {
    return result;
  }
  if (isArray) {
    let length = 0;
    try {
      length = (values as readonly unknown[]).length;
    } catch {
      return result;
    }
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SELECTION_ITEMS) {
      return result;
    }
    for (let index = 0; index < length; index += 1) {
      add(safeGet(values, index));
    }
    return result;
  }

  let isSet = false;
  let isMap = false;
  try {
    isSet = values instanceof Set;
    isMap = values instanceof Map;
  } catch {
    return result;
  }
  if (!isSet && !isMap) {
    if (values !== undefined && values !== null) {
      add(values);
    }
    return result;
  }

  try {
    const collection = values as Set<unknown> | Map<unknown, unknown>;
    if (collection.size > MAX_SELECTION_ITEMS) {
      return result;
    }
    const iterator = isMap
      ? (collection as Map<unknown, unknown>).values()
      : (collection as Set<unknown>).values();
    let count = 0;
    for (let current = iterator.next(); !current.done; current = iterator.next()) {
      count += 1;
      if (count > MAX_SELECTION_ITEMS) {
        return [];
      }
      add(current.value);
    }
  } catch {
    return [];
  }
  return result;
}
