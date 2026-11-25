import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.util.Arrays;

/** Listing rows as JSON; holds the sorted code-unit offset index. Not thread-safe per instance use is fine (worker thread only). */
public class RowFetcher {
    private static final char[] HEX = "0123456789abcdef".toCharArray();
    private final Program prog;
    private final Listing listing;
    private final SymbolTable st;
    private final AddressSpace space;
    private long[] idx = new long[1 << 16];
    private int n;

    public RowFetcher(Program p) {
        prog = p;
        listing = p.getListing();
        st = p.getSymbolTable();
        space = p.getAddressFactory().getDefaultAddressSpace();
        CodeUnitIterator it = listing.getCodeUnits(p.getMemory().getLoadedAndInitializedAddressSet(), true);
        while (it.hasNext()) {
            if (n == idx.length) idx = Arrays.copyOf(idx, n * 2);
            idx[n++] = it.next().getMinAddress().getOffset();
        }
    }

    public int size() { return n; }
    public long offsetAt(int i) { return idx[i]; }

    /** index of exact offset, or -1 */
    public int indexOf(long off) {
        int i = Arrays.binarySearch(idx, 0, n, off);
        return i >= 0 ? i : -1;
    }

    /** rows [start, start+count) as a JSON array string; caller clamps. */
    public String rowsJson(int start, int count) {
        StringBuilder sb = new StringBuilder(count * 120).append('[');
        CodeUnitIterator it = listing.getCodeUnits(space.getAddress(idx[start]), true);
        for (int k = 0; k < count && it.hasNext(); k++) {
            CodeUnit cu = it.next();
            Address a = cu.getMinAddress();
            if (k > 0) sb.append(',');
            String ha = "0x" + Long.toHexString(a.getOffset());
            sb.append("{\"address\":\"").append(ha).append("\",\"bytes\":\"");
            try {
                byte[] b = cu.getBytes();
                for (int i = 0; i < b.length; i++) {
                    if (i > 0) sb.append(' ');
                    sb.append(HEX[(b[i] >> 4) & 15]).append(HEX[b[i] & 15]);
                }
            } catch (Exception e) { /* unreadable: empty, same as nothing to show */ }
            sb.append("\",\"mnemonic\":");
            esc(sb, cu.getMnemonicString());
            sb.append(",\"operands\":");
            if (cu instanceof Instruction ins) {
                StringBuilder o = new StringBuilder();
                for (int i = 0, m = ins.getNumOperands(); i < m; i++) {
                    if (i > 0) o.append(", ");
                    o.append(ins.getDefaultOperandRepresentation(i));
                }
                esc(sb, o);
            } else esc(sb, ((Data) cu).getDefaultValueRepresentation());
            Symbol s = st.getPrimarySymbol(a);
            if (s != null) { sb.append(",\"label\":"); esc(sb, s.getName()); }
            String c = cu.getComment(CommentType.EOL);
            if (c != null && !c.isEmpty()) { sb.append(",\"comment\":"); esc(sb, c); }
            sb.append('}');
        }
        return sb.append(']').toString();
    }

    private static void esc(StringBuilder sb, CharSequence s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        sb.append('"');
    }
}
