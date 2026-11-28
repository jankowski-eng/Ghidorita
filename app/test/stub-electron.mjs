// Stand-in for `electron` in tests that bundle main-process code: Menu.buildFromTemplate returns the template, setApplicationMenu keeps it.
export const Menu = { buildFromTemplate: (t) => t, setApplicationMenu: (t) => { globalThis.__builtMenu = t; } };
export const app = { getPath: () => "/tmp/ghidorita-test", on() {} };
export const BrowserWindow = class {};
export const clipboard = { writeText: (t) => { globalThis.__clipboard = t; } };
