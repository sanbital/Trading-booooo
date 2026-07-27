function inspect(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return `${item}n`;
      if (item instanceof Set) return { __set: [...item] };
      if (item instanceof Map) return { __map: [...item.entries()] };
      return item;
    });
  } catch {
    return String(value);
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left == null || right == null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
    return [...left].every((value) => [...right].some((item) => deepEqual(value, item)));
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    return [...left].every(([key, value]) =>
      [...right].some(([otherKey, otherValue]) =>
        deepEqual(key, otherKey) && deepEqual(value, otherValue)
      )
    );
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Reflect.ownKeys(leftRecord);
    const rightKeys = Reflect.ownKeys(rightRecord);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        deepEqual(leftRecord[key as string], rightRecord[key as string])
      );
  }
  return false;
}

export function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals<T>(
  actual: T,
  expected: T,
  message?: string,
): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      message || `Values are not equal:\nactual: ${inspect(actual)}\nexpected: ${inspect(expected)}`,
    );
  }
}

export function assertAlmostEquals(
  actual: number,
  expected: number,
  tolerance = 1e-7,
  message?: string,
): void {
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(expected) ||
    Math.abs(actual - expected) > Math.abs(tolerance)
  ) {
    throw new Error(
      message ||
        `Values are not approximately equal: actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
    );
  }
}
