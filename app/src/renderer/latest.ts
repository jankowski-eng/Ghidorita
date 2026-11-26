/**
 * Latest-reply-wins: wrap each async request in the returned function; only the most recently started one
 * resolves with its value, older ones resolve null (and their errors are swallowed).
 */
export function latest() {
  let n = 0;
  return <T>(p: Promise<T>): Promise<T | null> => {
    const my = ++n;
    return p.then((v) => (my === n ? v : null), (e) => { if (my === n) throw e; return null; });
  };
}
