# Ghidorita providers

## Run either backend

Build once from the repository root:

```sh
cd app
npm ci
npm run build
```

Launch PyGhidra with the development virtual environment and the Ghidra installation from the [setup instructions](README.md). Run from `app/`:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home
export GHIDRA_INSTALL_DIR="$PWD/../ghidra-install/ghidra_12.3_DEV"
GHIDORITA_PROVIDER=pyghidra ./node_modules/.bin/electron .
```

Launch the read-only provider from the same build:

```sh
GHIDORITA_PROVIDER=fixture ./node_modules/.bin/electron .
```

Open `app/providers/example.ghidorita.json` and select `overlay_return`. The listing jumps to `overlay::fedcba9876543060`. The provider runs on Electron's bundled Node runtime and needs no Ghidra, JVM, Python, or project. PyGhidra remains the default. `MOCK=1` and `SIDECAR_CMD` retain their development roles. An explicit `GHIDORITA_PROVIDER` takes precedence.

On macOS, the full distribution includes both providers. From `app/`, run `npm run dist` to build it. Select the fixture provider by setting `GHIDORITA_PROVIDER=fixture` when running the app executable. For a package that contains only the fixture provider, run `npm run dist:fixture` and launch it with:

```sh
GHIDORITA_PROVIDER=fixture ./dist/fixture/mac-arm64/Ghidorita.app/Contents/MacOS/Ghidorita
```

## Fixture format

The top-level JSON object has `format: "ghidorita-listing-v1"`, `ranges` and `functions`. A range has a canonical `start` address and an array of contiguous rows. Each row has `bytes` (one to sixteen lowercase hex bytes separated by spaces), `mnemonic`, and optional `operands`. The byte count determines the row length. Start another range for a gap or a different space. Keep ranges ordered, disjoint and grouped by space.

Each function has `name`, `entry`, `size` in bytes, and `signature`. Its entry must be the start of a row, and the entire function must fit in one range. Functions may not overlap. Empty function and range arrays are supported. A fixture must be a regular file up to 2 MiB.

## Add a provider

1. Implement the [process and browsing contract](protocol.md#process-contract) in the provider's own runtime. Start with discovery and an empty capability list. Use a fresh session ID for every successful open, include the open request ID in progress, and require the active session ID on reads, writes and close.
2. While developing, run `SIDECAR_CMD=/absolute/path/to/provider-wrapper ./node_modules/.bin/electron .` from `app/`. The wrapper can handle paths with spaces and pass any required arguments. For a built-in provider, add its executable, argument array, environment and resources to [providers.ts](app/src/main/providers.ts). Stage only its required resources in the package and use a provider-specific storage directory if it persists results.
3. Add the provider to the shared [contract test](sidecar/test_provider_contract.py) with a supported sample. Run it and the built [Electron flows](sidecar/test_provider_ui.py). Advertise additional capabilities once the corresponding operations pass. The renderer consumes [application operations](app/src/renderer/backend.ts), and [wire validation](app/src/renderer/wire.ts) checks the payloads before use.

From the repository root:

```sh
npm --prefix app run typecheck
npm --prefix app test
(cd sidecar && .venv/bin/python -m pytest -q test_provider_contract.py test_provider_ui.py)
```

The integration tests need local loopback access. Electron tests also need a graphical session, and the PyGhidra cases need the configured Ghidra installation and Java runtime.
