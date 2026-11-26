/** "1 function", "2 functions". */
export const plural = (n: number | bigint, word: string) => `${n.toLocaleString()} ${word}${n === 1 || n === 1n ? "" : "s"}`;

/** File and section sizes: "48 bytes", "3 KB", "1.5 MB" (under 1 KB is never rounded up to 1 KB). */
export const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : plural(n, "byte"));
