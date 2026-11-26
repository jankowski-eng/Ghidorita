# Ghidra desktop spike: Electron frontend

    npm install
    npm start                                  # builds (electron-vite) and launches; spawns sidecar/.venv/bin/python sidecar/main.py
    MOCK=1 npm start                           # fake sidecar (mock/server.mjs): 5000 functions, 2M listing rows
    SIDECAR_CMD="python3 /path/main.py" npm start   # custom sidecar (whitespace-split, no quoting)
    MOCK=1 AUTOTEST=/bin/ls npm start          # scripted self-test; prints AUTOTEST_RESULT {json}, exit 0/1, writes out/screenshot.png
    npx tsc --noEmit
    npm test                                   # pure-logic unit tests (node --test)

Main spawns the sidecar (stdin pipe kept open), reads the port from the first stdout line, and the renderer connects to ws://127.0.0.1:<port> directly.
Protocol types are imported (type-only) from ../protocol.ts.

Main always generates a random SIDECAR_TOKEN for the sidecar (it refuses to start without one) and strips SIDECAR_ALLOW_NO_AUTH from its environment; the mock ignores the token.
Window close and Cmd+Q are vetoed in main until the renderer approves (it prompts Save / Don't Save / Cancel when the program is dirty); SIGTERM and the autotest exit skip the prompt.
The autotest ends by closing the window through that real path (Cancel keeps the app alive, Don't Save quits).
