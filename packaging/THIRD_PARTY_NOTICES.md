# Third-party notices

Ghidorita bundles the components below. The license texts in this folder were copied from each component's own distribution at build time (`packaging/prepare.sh`). `../BUILD_INFO.json` records the exact versions.

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

The C libraries linked into python-build-standalone (OpenSSL, SQLite, libffi, zlib, xz, bzip2, ncurses, libedit, expat, mpdecimal, zstd, …) have their license texts in `python/LICENSE.*.txt`. They come from the `python/licenses/` folder of python-build-standalone's `-full` archive for release 20261110 (CPython 3.12.16), kept in the repository under `packaging/licenses/python-build-standalone/`; refresh them when the pinned Python changes.

## GPL components and corresponding source

The Ghidra `GPL/` folder (`../ghidra/GPL/`) contains the GNU demangler (`demangler_gnu_v2_24`, `demangler_gnu_v2_41`, GPL-3.0, built from GNU binutils) and the DMG file-system support. They are separate programs/modules that Ghidra starts or loads; the OpenJDK runtime is GPLv2 with the Classpath Exception. The corresponding source:

- Ghidra, including `GPL/`: https://github.com/NationalSecurityAgency/ghidra at the commit in `../BUILD_INFO.json` (`ghidraCommit`).
- OpenJDK: https://github.com/openjdk/jdk, the tag matching `jdk` in `../BUILD_INFO.json`.

The Ghidorita maintainers still have to decide whether to add a written offer for the source (for example in the release notes or the download page); this file only records where the source is.
