// Bounded per-session maps in a long-lived host process. A Map's insertion
// order is its age, so a read through these moves the key to the newest end and
// the session in use is never the one dropped when the map is full.

/** The value, moved to the newest end; undefined when the key is not there. */
export function recent<Key, Value>(map: Map<Key, Value>, key: Key): Value | undefined {
  const value = map.get(key)
  if (value === undefined) return undefined
  map.delete(key)
  map.set(key, value)
  return value
}

/** Whether the set has the key, moving it to the newest end when it does. */
export function recentlySeen<Key>(set: Set<Key>, key: Key): boolean {
  if (!set.delete(key)) return false
  set.add(key)
  return true
}
