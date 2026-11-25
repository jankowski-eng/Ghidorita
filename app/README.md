# Ghidra desktop spike: Electron frontend

    npm install
    npm start                                  # builds (electron-vite) and launches; spawns sidecar/.venv/bin/python sidecar/main.py
    MOCK=1 npm start                           # fake sidecar (mock/server.mjs): 5000 functions, 2M listing rows
    SIDECAR_CMD="python3 /path/main.py" npm start   # custom sidecar (whitespace-split, no quoting)
    MOCK=1 AUTOTEST=/bin/ls npm start          # scripted self-test; prints AUTOTEST_RESULT {json}, exit 0/1, writes out/screenshot.png
    npx tsc --noEmit

Main spawns the sidecar (stdin pipe kept open), reads the port from the first stdout line, and the renderer connects to ws://127.0.0.1:<port> directly.
Protocol types are imported (type-only) from ../protocol.ts.
