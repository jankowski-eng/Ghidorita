# Debugging: Ghidra's debugger and Ghidrette's

Researched against the Ghidra build in `ghidra-install/` (12.3 DEV): its `docs/WhatsNew.md`, the `Ghidra/Debug/*` modules and their launcher scripts, and the constructors of the Trace RMI classes (`javap`).

## How Ghidra's debugger works

- **A trace, not a connection.** The Debugger records the target into a *trace* (`Framework-TraceModeling`, a database of target objects, memory and registers over snapshots). The views (Registers, Memory, Threads, Modules, Time) render the trace; "Control" actions are commands to whatever fills it.
- **Agents push over Trace RMI.** `Debugger-rmi-trace` defines a protobuf-over-TCP protocol (`ghidra.rmi.trace.TraceRmi`). The Java side (`TraceRmiPlugin`, `TraceRmiServer`, `TraceRmiHandler`) listens; an *agent* is a separate process that connects and sends the trace. The agents are Python packages that run **inside** the native debugger: `Debugger-agent-gdb` (inside gdb, via its Python API), `-lldb`, `-dbgeng` (Windows), `-x64dbg`, `-drgn` (Linux kernel), plus JDI and DAP bridges. The Python client library is `ghidratrace` (`Debugger-rmi-trace/pypkg`).
- **QEMU is gdb on QEMU's stub.** The shipped launcher `qemu-sys-gdb.sh` starts `qemu-system-* -S -gdb tcp::1234` and then starts **gdb (`gdb-multiarch`)**, with the agent loaded into it, connected to the stub. Every target Ghidra debugs live goes through a real gdb/lldb/dbgeng.
- **Static mappings.** The trace has its own addresses; the *Static Mappings* service maps trace ranges (by module) to programs in the project, so the listing/decompiler follow the program counter. Relocation (ASLR, loaded modules) is handled there. Ghidrette keeps one `offset` for this and no mapping UI yet.
- **Also in the Debugger tool:** a P-code emulator (`DebuggerEmulationService`, usable without a target), time-travel views (the 12.x "timeless debugging", a Tenet-based trace importer), and stepping at p-code granularity.
- **GUI only.** Everything above is plugins (`TraceRmiPlugin`, `DebuggerStaticMappingServicePlugin`, `DebuggerEmulationServicePlugin`) inside a `PluginTool`. The Trace RMI server and handler constructors take the `TraceRmiPlugin` (`TraceRmiServer(TraceRmiPlugin, SocketAddress)`, `TraceRmiHandler(TraceRmiPlugin, Socket)`).

## Can PyGhidra drive it?

Not usefully, for this app:

1. **The pieces that debug are GUI services.** PyGhidra gives a headless Ghidra: a `Program`, the decompiler, the analysis managers. There is no `PluginTool` with the Debugger plugins running, so no Trace RMI server, no target control or trace views. Constructing a `PluginTool` and the plugin by hand inside the sidecar's JVM would mean pulling in the GUI framework (Swing/docking) in a process that is deliberately headless, against internal classes.
2. **It would still need gdb.** The agents live in gdb/lldb/dbgeng, which are not on a Mac by default (there is no `gdb` on this Mac). Ghidrette would depend on a second tool chain for what QEMU's stub already speaks directly.
3. **Control and data are separated the wrong way for us.** In Ghidra the agent pushes a trace and the GUI commands the agent through the RMI channel; Ghidrette's UI is Electron and talks to the sidecar. We would be rebuilding the Trace views on top of the Java trace model through JPype.

What *is* available headlessly and worth keeping in mind: the **P-code emulator** (`ghidra.pcode.emu.PcodeEmulator`, plain library code) for running code without QEMU, and the **trace database** classes as a storage format. Neither is needed for this slice.

## What Ghidrette does instead

`sidecar/ghidrette/core/gdb.py` speaks the GDB Remote Serial Protocol to the stub itself (about 150 lines: framing, a reader thread, `qXfer:features:read` for the register description, `Z0`/`z0`, `c`, `s`, Ctrl-C). `domains/debug.py` maps the stop address and registers onto the program (names from the program's Ghidra language, numbers from the target's `target.xml`) and announces them as `debug_state`. The renderer shows them in the listing, decompiler and a Registers tab.

| | Ghidra Debugger | Ghidrette |
|---|---|---|
| Target link | agent inside gdb/lldb/dbgeng, Trace RMI | RSP to the stub, pure Python |
| Needs on the host | gdb (or lldb, dbgeng), Python, the GUI | `qemu-system-*` (or any RSP stub) |
| Model | a trace database with snapshots, many views | the last stop, breakpoints, registers |
| Address mapping | Static Mappings service | one `offset` (0: image loaded where it runs) |
| Stepping | instruction, p-code, over/into/out | instruction (F8), decompiler statement over (F7), into (F10), out (Shift+F10) |
| Recording / time travel | traces, emulator, Tenet import | the stops are recorded and can be viewed again (no reverse execution) |
| Values | register, memory and stack views from the trace | the decompiler's variables with values at the stop, memory through data types |
| Targets | local and remote processes, kernels, QEMU | QEMU / any gdb stub first |

The statement step is the part Ghidra does not have as such: it runs the target to a boundary of the decompiler's own line mapping, so the stop and the highlight in the decompiler agree by construction.

## Limits worth knowing

- RSP gives us what the stub offers: QEMU's stub has no memory map or module list, so there is no module-based mapping to automate; relocation will be a user-given offset first.
- Values of stack variables need Ghidra's stack depth at the stop (unknown after some AArch64 prologues), register variables are not checked for liveness. A statement step is only as good as the decompiler's address mapping: Ghidra maps a few instructions per line (a prologue maps to nothing; the stop at a function's entry highlights the first mapped line).
- Going back needs a recording: RSP has reverse-step packets only where the stub implements them (QEMU's replay mode does; not wired up here), and Ghidra's time travel works on traces it imported or recorded. Not part of this slice.
