import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Program;
import ghidra.program.model.symbol.Namespace;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolType;
import ghidra.program.util.DefinedStringIterator;
import ghidra.util.exception.CancelledException;
import ghidra.util.task.TaskMonitor;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * The two loops that were Python over JPype objects (defined-string scan, symbol kind filter and sort), moved next to the data so only results cross
 * into Python: a Java call releases the GIL, and the loop makes no JPype call per element. Cancellation: the loops poll the TaskMonitor
 * (CancelledException). Called from sidecar/main.py on a scan worker; nothing here touches the program except by reading.
 */
public final class GhidretteScans {
    private GhidretteScans() {}

    public static final int STRING_VALUE_CAP = 1000;
    public static final int K_FUNCTION = 1, K_LABEL = 2, K_DATA = 4, K_EXTERNAL = 8, K_VARIABLE = 16, K_OTHER = 32;

    // ---- strings -------------------------------------------------------------------------------------------------------------

    /** All defined strings of one minLength scan, address order; filtered pages are served from here. */
    public static final class Strings {
        private final String[] addr;  // formatted as the protocol does (default space "0x..", others space-qualified)
        private final int[] len;
        private final String[] val;
        private String[] lower;
        private String lastQuery;
        private int[] lastHits;

        Strings(String[] addr, int[] len, String[] val) { this.addr = addr; this.len = len; this.val = val; }

        public int size() { return val.length; }

        /** Rows matching `queryLower` (empty = all) from offset, as {"total":n,"items":[{address,value,length}]}. ASCII-only JSON (non-ASCII as \\u escapes). */
        public synchronized String page(int offset, int limit, String queryLower) {
            int[] hits = null;
            int total = val.length;
            if (!queryLower.isEmpty()) {
                if (!queryLower.equals(lastQuery)) {
                    if (lower == null) {
                        lower = new String[val.length];
                        for (int i = 0; i < val.length; i++) lower[i] = val[i].toLowerCase(Locale.ROOT);
                    }
                    int[] h = new int[16];
                    int n = 0;
                    for (int i = 0; i < lower.length; i++) {
                        if (lower[i].contains(queryLower)) {
                            if (n == h.length) h = Arrays.copyOf(h, n * 2);
                            h[n++] = i;
                        }
                    }
                    lastQuery = queryLower;
                    lastHits = Arrays.copyOf(h, n);
                }
                hits = lastHits;
                total = hits.length;
            }
            StringBuilder sb = new StringBuilder(Math.min(limit, 5000) * 80 + 32).append("{\"total\":").append(total).append(",\"items\":[");
            int end = (int) Math.min((long) offset + limit, total);
            for (int k = offset; k < end; k++) {
                int i = hits == null ? k : hits[k];
                if (k > offset) sb.append(',');
                sb.append("{\"address\":\"").append(addr[i]).append("\",\"value\":");
                json(sb, val[i]);
                sb.append(",\"length\":").append(len[i]).append('}');
            }
            return sb.append("]}").toString();
        }
    }

    /** The protocol's address string (session.fmtr): default space "0x<hex>", others "<space>:<hex>" ("::" for overlay spaces); offsets unsigned. */
    static String fmt(Address a, long defaultSpaceId) {
        AddressSpace sp = a.getAddressSpace();
        String h = Long.toHexString(a.getOffset());
        return sp.getSpaceID() == defaultSpaceId ? "0x" + h : sp.getName() + (sp.isOverlaySpace() ? "::" : ":") + h;
    }

    /** Scans every defined string (DefinedStringIterator), keeps those of at least minLength code points. Values are cut at STRING_VALUE_CAP UTF-16 units. */
    public static Strings strings(Program prog, int minLength, TaskMonitor mon) throws CancelledException {
        ArrayList<String> vals = new ArrayList<>();
        String[] addr = new String[1024];
        long dsid = prog.getAddressFactory().getDefaultAddressSpace().getSpaceID();
        int[] len = new int[1024];
        int n = 0;
        for (Data d : DefinedStringIterator.forProgram(prog)) {
            if ((n & 255) == 0) mon.checkCancelled();
            Object v = d.getValue();  // the String for string data types; the StringDataInstance is the fallback (e.g. a pointer-typed string)
            if (!(v instanceof String)) v = StringDataInstance.getStringDataInstance(d).getStringValue();
            if (v == null) continue;
            String s = (String) v;
            if (s.codePointCount(0, s.length()) < minLength) continue;
            if (s.length() > STRING_VALUE_CAP) {
                int cut = STRING_VALUE_CAP;
                if (Character.isHighSurrogate(s.charAt(cut - 1))) cut--;
                s = s.substring(0, cut);
            }
            if (n == addr.length) { addr = Arrays.copyOf(addr, n * 2); len = Arrays.copyOf(len, n * 2); }
            addr[n] = fmt(d.getMinAddress(), dsid);
            len[n] = d.getLength();
            vals.add(s);
            n++;
        }
        return new Strings(Arrays.copyOf(addr, n), Arrays.copyOf(len, n), vals.toArray(new String[0]));
    }

    // ---- symbols -------------------------------------------------------------------------------------------------------------

    public static String kind(Program prog, Symbol s) {
        SymbolType t = s.getSymbolType();
        if (t == SymbolType.FUNCTION) return "function";
        if (t == SymbolType.LOCAL_VAR || t == SymbolType.PARAMETER) return "variable";
        if (s.isExternal()) return "external";
        if (t == SymbolType.LABEL) return prog.getListing().getDefinedDataAt(s.getAddress()) != null ? "data" : "label";
        return "other";
    }

    private static int kindBit(String k) {
        return switch (k) {
            case "function" -> K_FUNCTION;
            case "label" -> K_LABEL;
            case "data" -> K_DATA;
            case "external" -> K_EXTERNAL;
            case "variable" -> K_VARIABLE;
            default -> K_OTHER;
        };
    }

    private static String source(Symbol s) {
        return switch (s.getSource().name()) {
            case "USER_DEFINED" -> "user";
            case "ANALYSIS" -> "analysis";
            case "IMPORTED" -> "imported";
            case "DEFAULT" -> "default";
            default -> "other";
        };
    }

    private record Row(Symbol s, String k1, String k2, long a, boolean mem) {}

    /**
     * Symbols whose name contains `query` (glob match inside Ghidra, as search_symbols), restricted to the kinds in `kindMask` (0 = all), ordered by
     * `sort` (name|address|kind|namespace|source; ties by lower-cased name, then Ghidra's iteration order: the sort is stable). `address` with no
     * query keeps the iterator order, which already is by address.
     */
    public static List<Symbol> symbols(Program prog, String query, int kindMask, String sort, TaskMonitor mon) throws CancelledException {
        SymbolIterator it = query.isEmpty() ? prog.getSymbolTable().getSymbolIterator(true)
                                            : prog.getSymbolTable().getSymbolIterator("*" + query + "*", false);
        boolean ordered = sort.equals("address") && query.isEmpty();
        List<Row> rows = new ArrayList<>();
        int n = 0;
        for (Symbol s : it) {
            if ((++n & 255) == 0) mon.checkCancelled();
            String k = kind(prog, s);
            if (kindMask != 0 && (kindMask & kindBit(k)) == 0) continue;
            if (ordered) { rows.add(new Row(s, null, null, 0, false)); continue; }
            String name = s.getName().toLowerCase(Locale.ROOT);
            Address a = s.getAddress();
            Row r = switch (sort) {
                case "name" -> new Row(s, name, "", 0, false);
                case "address" -> new Row(s, name, "", a.isMemoryAddress() ? a.getOffset() : 0, a.isMemoryAddress());
                case "kind" -> new Row(s, k, name, 0, false);
                case "namespace" -> {
                    Namespace ns = s.getParentNamespace();
                    yield new Row(s, ns.isGlobal() ? "" : ns.getName(true).toLowerCase(Locale.ROOT), name, 0, false);
                }
                default -> new Row(s, source(s), name, 0, false);
            };
            rows.add(r);
        }
        if (!ordered) {
            mon.checkCancelled();
            Comparator<Row> c = sort.equals("address")
                    ? Comparator.comparing(Row::mem).thenComparing((x, y) -> Long.compareUnsigned(x.a(), y.a()))  // unsigned offsets, symbols without a memory address first
                    : Comparator.comparing(Row::k1).thenComparing(Row::k2);
            rows.sort(c);  // List.sort is a stable merge sort
        }
        List<Symbol> out = new ArrayList<>(rows.size());  // a List, not Symbol[]: JPype cannot build the array class of a Ghidra type here
        for (Row r : rows) out.add(r.s());
        return out;
    }

    /** all[offset .. offset+limit), or of the reversed list when desc. */
    public static List<Symbol> slice(List<Symbol> all, int offset, int limit, boolean desc) {
        int size = all.size(), end = (int) Math.min((long) offset + limit, size);
        List<Symbol> out = new ArrayList<>(Math.max(0, end - offset));
        for (int i = offset; i < end; i++) out.add(desc ? all.get(size - 1 - i) : all.get(i));
        return out;
    }

    // ---- json ----------------------------------------------------------------------------------------------------------------

    private static void json(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c >= 0x20 && c < 0x7f) sb.append(c);
            else sb.append(String.format("\\u%04x", (int) c));  // control, non-ASCII and lone surrogates: always valid JSON
        }
        sb.append('"');
    }
}
