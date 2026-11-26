# Third-party notices

Ghidrette bundles the components below. The license texts in this folder were copied from each component's own distribution at build time (`packaging/prepare.sh`). `../BUILD_INFO.json` records the exact versions.

| Component | License | Where |
|---|---|---|
| Ghidra (NSA), `../ghidra/` | Apache-2.0 | `ghidra/LICENSE`, `ghidra/NOTICE`. Ghidra's own third-party licenses are in `../ghidra/licenses/` and `../ghidra/GPL/licenses/`. `../ghidra/GPL/` holds GPL-licensed parts (GNU demangler, DMG support) that ship as separate programs/modules; their sources are in the Ghidra repository at the commit in `BUILD_INFO.json`. |
| OpenJDK runtime (`../jdk/`, a jlink image) | GPLv2 with Classpath Exception | `jdk/LICENSE`, `jdk/ASSEMBLY_EXCEPTION`, `jdk/ADDITIONAL_LICENSE_INFO`; per-module texts in `../jdk/legal/` |
| CPython (via python-build-standalone), `../python/` | PSF-2.0; python-build-standalone itself is MPL-2.0 | `python/LICENSE.cpython.txt`, `python/LICENSE.python-build-standalone.txt` |
| JPype1 | Apache-2.0 | `jpype/` |
| websockets | BSD-3-Clause | `websockets/` |
| packaging, typing_extensions, pyghidra | Apache-2.0/BSD, PSF-2.0, Apache-2.0 | `python/LICENSE.packaging*`, `LICENSE.typing_extensions`, `LICENSE.pyghidra` |
| Electron | MIT | `electron/LICENSE.electron` |
| Chromium and its dependencies (inside Electron) | various | `Contents/Resources/LICENSES.chromium.html` (shipped by Electron) |
| Monaco Editor, @monaco-editor/react, @monaco-editor/loader, state-local | MIT | `monaco/` (includes Monaco's `ThirdPartyNotices.txt`) |
| React, React DOM, scheduler | MIT | `react/` |
| TanStack Virtual | MIT | `tanstack/` |

Not included: the license texts of the C libraries linked into python-build-standalone (OpenSSL, SQLite, libffi, zlib, xz, bzip2, ncurses, readline, gdbm and so on). The `install_only` archive does not ship them; they are listed in python-build-standalone's own documentation.
