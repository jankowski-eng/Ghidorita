"""GDB Remote Serial Protocol client over TCP (what QEMU's gdbstub speaks), pure Python, no Ghidra. One reader thread owns the socket's
receive side. A command is answered through `replies`; after a resume (`c`, `s`) the next stop-class packet (T, S, W, X) goes to
`on_stop`, which runs on the reader thread and must not talk to the target itself (hand off to another thread).

shortcut: no-ack mode, run-length encoding and non-stop mode are not used (QEMU needs none of them); a packet that fails its checksum
is NAKed and dropped, the request then times out. Upgrade when a gdbserver over a lossy link is a target."""
import queue, re, socket, threading
import xml.etree.ElementTree as ET

XI = "{http://www.w3.org/2001/XInclude}include"


class GdbError(Exception):
    """A plain-words problem with the target (connection refused, lost, did not answer)."""


def frame(payload):
    return b"$" + payload.encode("latin-1") + b"#%02x" % (sum(payload.encode("latin-1")) & 255)


def unescape(s):
    out, i = [], 0
    while i < len(s):
        if s[i] == "}" and i + 1 < len(s):
            out.append(chr(ord(s[i + 1]) ^ 0x20)); i += 2
        else:
            out.append(s[i]); i += 1
    return "".join(out)


class Gdb:
    def __init__(self, host, port, on_stop, on_lost, timeout=3.0):
        try:
            self.sock = socket.create_connection((host, port), timeout)
        except ConnectionRefusedError:
            raise GdbError("Connection refused by %s:%d. Is QEMU running with -gdb tcp::%d?" % (host, port, port))
        except (OSError, UnicodeError) as e:  # timeout, unknown host, unreachable
            raise GdbError("Could not connect to %s:%d (%s)" % (host, port, getattr(e, "strerror", None) or e))
        self.sock.settimeout(None)
        self.on_stop, self.on_lost = on_stop, on_lost
        self.replies, self.lock, self.running, self.closed = queue.Queue(), threading.Lock(), False, False
        self.route = threading.Lock()  # where a stop reply goes (the waiter's queue or on_stop) is decided and handed over under this lock
        self.ctl = threading.Lock()  # a resume's start and a pause's check of `running` exclude each other: no Ctrl-C is lost between them
        self.sync = None  # a queue.Queue while a resume is waited for on the calling thread (step over a breakpoint)
        threading.Thread(target=self._read, daemon=True, name="gdb-reader").start()

    # ---- reader thread ----
    def _read(self):
        buf = ""
        try:
            while True:
                data = self.sock.recv(65536)
                if not data:
                    break
                buf += data.decode("latin-1")
                while True:
                    i = buf.find("$")
                    if i < 0:
                        buf = ""
                        break
                    j = buf.find("#", i)
                    if j < 0 or len(buf) < j + 3:
                        buf = buf[i:]
                        break
                    body, cs, buf = buf[i + 1:j], buf[j + 1:j + 3], buf[j + 3:]
                    ok = cs.lower() == "%02x" % (sum(body.encode("latin-1")) & 255)
                    self.sock.sendall(b"+" if ok else b"-")
                    if ok:
                        self._packet(body)
        except OSError:
            pass
        finally:
            was = self.closed
            self.closed = True
            self.replies.put(None)  # wakes a request that waits
            if self.sync is not None:
                self.sync.put(None)
            if not was:
                self.on_lost()

    def _packet(self, p):
        if self.running and p[:1] in ("T", "S", "W", "X"):
            with self.route:  # a waiter that times out takes the same lock: the stop is consumed by it or delivered to on_stop, never dropped
                self.running = False
                q = self.sync
                if q is not None:
                    q.put(p)
            if q is None:
                self.on_stop(p)
        elif self.running and p[:1] == "O":  # console output while running: not a reply
            pass
        else:
            self.replies.put(p)

    # ---- commands ----
    def _send(self, raw):
        if self.closed:
            raise GdbError("Lost the connection to the target")
        try:
            self.sock.sendall(raw)
        except OSError:
            raise GdbError("Lost the connection to the target")

    def request(self, payload, timeout=5.0):
        with self.lock:
            while not self.replies.empty():  # a stale reply must not answer this request
                self.replies.get_nowait()
            self._send(frame(payload))
            try:
                r = self.replies.get(timeout=timeout)
            except queue.Empty:
                r = False
        if r is False:  # replies carry no request id: a late one could answer the next request, so the connection is given up
            self.close(polite=False)
            self.on_lost()
            raise GdbError("The target did not answer; the connection was closed")
        if r is None:
            raise GdbError("Lost the connection to the target")
        return r

    def resume(self, payload, wait=False, timeout=5.0, before=None):
        """`c` or `s`. Without wait the stop reply goes to on_stop; with wait it is returned here. `before` is asked once the resume is
        about to start (under ctl, which a pause also takes): false means do not start, and "T02" (a stop by SIGINT, nothing was sent) is returned."""
        with self.lock:
            with self.ctl:
                if before is not None and not before():
                    return "T02"
                self.arm() if wait else None
                self.running = True
                try:
                    self._send(frame(payload))
                except GdbError:
                    self.running = False
                    raise
            if not wait:
                return None
            r = self.wait_stop(self.sync, timeout)
            if r is None:
                raise GdbError("Lost the connection to the target")
            return r

    def arm(self):
        """Route the next stop reply to a queue the caller waits on (see wait_stop)."""
        with self.route:
            self.sync = queue.Queue()
            return self.sync

    def wait_stop(self, q, timeout):
        """The stop reply that arrives in q (None: the connection ended). On timeout the target is left running, and its stop will go to on_stop
        unless it raced the timeout, in which case it is returned here."""
        try:
            r = q.get(timeout=timeout)
        except queue.Empty:
            with self.route:
                self.sync = None
                try:
                    return q.get_nowait()
                except queue.Empty:
                    raise GdbError("The target did not stop")
        with self.route:
            self.sync = None
        return r

    def interrupt(self):
        self._send(b"\x03")

    def close(self, polite=True):
        if self.closed:
            return
        self.closed = True  # the reader's EOF then does not report a lost connection
        try:
            if polite and not self.running:
                self.sock.sendall(frame("D"))
        except OSError:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()

    # ---- target description ----
    def read_xfer(self, name):
        out = ""
        while True:
            r = self.request("qXfer:features:read:%s:%x,fff" % (name, len(out.encode("latin-1"))))
            if r[:1] not in ("m", "l"):
                raise GdbError("The target does not describe its registers")
            out += unescape(r[1:])
            if r[0] == "l":
                return out

    def registers(self):
        """(architecture or "", [(name, regnum, bits)]) from target.xml and the files it includes."""
        regs, nxt, arch = [], [0], []

        def walk(el):
            nonlocal nxt
            for c in el:
                if c.tag == XI:
                    walk(ET.fromstring(self.read_xfer(c.get("href"))))
                elif c.tag == "reg":
                    n = int(c.get("regnum", nxt[0]))
                    regs.append((c.get("name"), n, int(c.get("bitsize"))))
                    nxt[0] = n + 1
                elif c.tag == "architecture":
                    arch.append((c.text or "").strip())
                else:
                    walk(c)
        xml = self.read_xfer("target.xml")
        if "xmlns:xi" not in xml:  # QEMU uses xi:include without declaring the prefix
            xml = re.sub(r"<target\b", '<target xmlns:xi="http://www.w3.org/2001/XInclude"', xml, count=1)
        try:
            walk(ET.fromstring(xml))
        except (ET.ParseError, TypeError, ValueError):
            raise GdbError("The target's register description is not readable")
        return (arch[0] if arch else ""), regs
