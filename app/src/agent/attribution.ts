// Which params objects the agent sent. rpc.ts hands the caller's own params object to the onEdit hook, so identity is a race-free tag
// (tagging "the newest entry" afterwards would hit a user's edit that landed in between).
const by = new WeakMap<object, string>();
export const tagParams = <T extends object>(params: T, client: string): T => { by.set(params, client); return params; };
export const agentOf = (params: unknown): string | undefined => (params && typeof params === "object" ? by.get(params) : undefined);

/** A connection's identity is `<clientInfo.name>#<n>` (unique for the app's lifetime): two sessions of one client must not share it. */
const base = (id: string) => id.replace(/#\d+$/, "");
/** What to show a person: the plain name, with `#n` only when another live connection has the same name. */
export const agentName = (id: string, live: readonly string[] = []): string => (live.some((o) => o !== id && base(o) === base(id)) ? id : base(id));
