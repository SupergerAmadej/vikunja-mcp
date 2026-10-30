// Shared across per-request MCP server instances. Release failed writes too, so
// an upstream failure cannot deadlock the next edit or leak queue entries.
const pending = new Map<string, Promise<void>>();

export async function serializedUpdate<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, turn);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (pending.get(key) === turn) pending.delete(key);
  }
}
