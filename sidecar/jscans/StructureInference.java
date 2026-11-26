/* ###
 * IP: GHIDRA
 *
 * Pointer tracing adapted from Ghidra's FillOutStructureHelper.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.component.DecompilerUtils;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.DataType;
import ghidra.program.model.data.NoisyStructureBuilder;
import ghidra.program.model.data.Structure;
import ghidra.program.model.lang.PrototypeModel;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Program;
import ghidra.program.model.pcode.HighFunction;
import ghidra.program.model.pcode.HighSymbol;
import ghidra.program.model.pcode.HighVariable;
import ghidra.program.model.pcode.PcodeOp;
import ghidra.program.model.pcode.Varnode;
import ghidra.util.exception.CancelledException;
import ghidra.util.task.TaskMonitor;

/** Read-only, cancellable inference. The caller applies the resulting field map in a transaction. */
final class StructureInference {
    private record PointerRef(Varnode node, long offset) {}

    static NoisyStructureBuilder infer(Program program, HighVariable root, Structure existing,
            DecompInterface decompiler, TaskMonitor monitor) throws CancelledException {
        monitor.checkCancelled();
        var fields = new NoisyStructureBuilder();
        if (existing != null) {
            fields.populateOriginalStructure(existing);
        }
        Map<Address, Address> calls = new HashMap<>();
        trace(program, root, fields, calls, monitor);
        // Like FillOutStructureHelper, follow one level of direct calls.
        for (var call : calls.entrySet()) {
            monitor.checkCancelled();
            Function callee = program.getFunctionManager().getFunctionAt(call.getKey());
            if (callee == null) {
                continue;
            }
            // The request's timed monitor covers the root decompile, every callee, and tracing.
            var result = decompiler.decompileFunction(callee, 0, monitor);
            monitor.checkCancelled();
            HighFunction high = result.getHighFunction();
            if (high != null) {
                HighSymbol symbol = findParameter(high, call.getValue(), callee.getEntryPoint());
                if (symbol != null && symbol.getHighVariable() != null) {
                    trace(program, symbol.getHighVariable(), fields, null, monitor);
                }
            }
        }
        monitor.checkCancelled();
        return fields;
    }

    private static HighSymbol findParameter(HighFunction high, Address storage, Address entry) {
        Address[] pcs = {entry.subtractWrap(1L), null, entry};
        for (Address pc : pcs) {
            HighSymbol symbol = high.getMappedSymbol(storage, pc);
            if (symbol != null) {
                return symbol;
            }
        }
        for (Address pc : pcs) {
            HighSymbol symbol = high.getLocalSymbolMap().findLocal(storage, pc);
            if (symbol != null) {
                return symbol;
            }
        }
        return null;
    }

    private static void trace(Program program, HighVariable root, NoisyStructureBuilder fields,
            Map<Address, Address> calls, TaskMonitor monitor) throws CancelledException {
        var queue = new ArrayDeque<PointerRef>();
        var visited = new HashSet<Varnode>();
        Varnode representative = root.getRepresentative();
        if (representative != null) {
            queue.add(new PointerRef(representative, 0));
            visited.add(representative);
        }
        for (Varnode node : root.getInstances()) {
            monitor.checkCancelled();
            if (visited.add(node)) {
                queue.add(new PointerRef(node, 0));
            }
        }
        while (!queue.isEmpty()) {
            monitor.checkCancelled();
            PointerRef ref = queue.remove();
            var descendants = ref.node().getDescendants();
            while (descendants.hasNext()) {
                monitor.checkCancelled();
                PcodeOp op = descendants.next();
                Varnode output = op.getOutput();
                long offset = ref.offset();
                switch (op.getOpcode()) {
                    case PcodeOp.INT_ADD, PcodeOp.INT_SUB, PcodeOp.PTRADD, PcodeOp.PTRSUB -> {
                        Varnode delta = op.getInput(1);
                        if (!delta.isConstant() ||
                                (op.getOpcode() == PcodeOp.PTRADD && !op.getInput(2).isConstant())) {
                            continue;
                        }
                        long value = signedOffset(delta);
                        offset += switch (op.getOpcode()) {
                            case PcodeOp.INT_SUB -> -value;
                            case PcodeOp.PTRADD -> value * op.getInput(2).getOffset();
                            default -> value;
                        };
                        if (offset < 0 || (offset >= fields.getSize() && offset > 0x1000)) {
                            continue;
                        }
                        fields.setMinimumSize(offset);
                    }
                    case PcodeOp.SEGMENTOP -> fields.setMinimumSize(offset);
                    case PcodeOp.CAST, PcodeOp.MULTIEQUAL, PcodeOp.COPY -> {}
                    case PcodeOp.LOAD -> {
                        fields.addDataType(offset, DecompilerUtils.getDataTypeTraceForward(output));
                        continue;
                    }
                    case PcodeOp.STORE -> {
                        if (op.getSlot(ref.node()) == 1) {
                            fields.addDataType(offset, DecompilerUtils.getDataTypeTraceBackward(op.getInput(2)));
                        }
                        continue;
                    }
                    case PcodeOp.CALL, PcodeOp.CALLIND -> {
                        if (op.getOpcode() == PcodeOp.CALL && offset == 0) {
                            if (calls != null) {
                                recordCall(program, op, ref.node(), calls);
                            }
                        }
                        else {
                            fields.addReference(offset, DecompilerUtils.getDataTypeTraceBackward(ref.node()));
                        }
                        continue;
                    }
                    default -> {
                        continue;
                    }
                }
                if (output != null && visited.add(output)) {
                    queue.add(new PointerRef(output, offset));
                }
            }
        }
    }

    private static long signedOffset(Varnode node) {
        int shift = Long.SIZE - node.getSize() * Byte.SIZE;
        return (node.getOffset() << shift) >> shift;
    }

    private static void recordCall(Program program, PcodeOp call, Varnode node, Map<Address, Address> calls) {
        int slot = call.getSlot(node);
        if (slot <= 0) {
            return;
        }
        Address target = call.getInput(0).getAddress();
        Function function = program.getFunctionManager().getFunctionAt(target);
        if (function == null) {
            return;
        }
        var params = function.getParameters();
        Address storage;
        if (slot <= params.length) {
            storage = params[slot - 1].getMinAddress();
        }
        else {
            PrototypeModel model = function.getCallingConvention();
            if (model == null) {
                model = program.getCompilerSpec().getDefaultCallingConvention();
                if (model == null) {
                    return;
                }
            }
            DataType[] types = new DataType[slot + 1];
            types[0] = DataType.DEFAULT;
            for (int i = 1; i <= slot; i++) {
                types[i] = call.getInput(i).getHigh().getDataType();
            }
            storage = model.getStorageLocations(program, types, false, function.hasVarArgs())[slot].getMinAddress();
        }
        if (storage != null) {
            calls.put(target, storage);
        }
    }
}
