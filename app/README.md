# Ghidorita (Ghidra desktop spike): Electron frontend

    npm install
    npm start                                  # builds (electron-vite) and launches the default provider, PyGhidra: sidecar/.venv/bin/python sidecar/main.py
    GHIDORITA_PROVIDER=fixture npm start       # read-only provider, no Ghidra/JVM/Python (see ../PROVIDERS.md)
    MOCK=1 npm start                           # fake sidecar (mock/server.mjs): 5000 functions, 2M listing rows
    SIDECAR_CMD="python3 /path/main.py" npm start   # external provider (whitespace-split, no quoting; see ../PROVIDERS.md)
    MOCK=1 AUTOTEST=/bin/ls npm start          # scripted self-test; prints AUTOTEST_RESULT {json}, exit 0/1, writes out/screenshot.png
    npx tsc --noEmit
    npm test                                   # pure-logic unit tests (node --test)

Main (`src/main/providers.ts` picks the launch spec, `providerProcess.ts` supervises it) spawns the selected provider (stdin pipe kept open), reads the port from the first stdout line, and the renderer connects to ws://127.0.0.1:<port>/<token> directly.
The renderer reaches the provider only through the interfaces in `src/renderer/backend.ts`; `rpc.ts` and `wire.ts` are the one adapter (`npm test` fails if another module imports them). Protocol types are imported (type-only) from ../protocol.ts.

Main always generates a random SIDECAR_TOKEN for the provider (the PyGhidra sidecar refuses to start without one; every provider must accept only the path `/<token>`) and strips SIDECAR_ALLOW_NO_AUTH from its environment.
Window close and Cmd+Q are vetoed in main until the renderer approves (it prompts Save / Don't Save / Cancel when the program is dirty); SIGTERM and the autotest exit skip the prompt.
The autotest ends by closing the window through that real path (Cancel keeps the app alive, Don't Save quits).
