"""core/gdb.py against a fake gdbstub on a local socket: framing, requests, a resume with its stop reply, a lost connection. No QEMU, no JVM."""
import socket, threading, queue

import pytest

from ghidorita.core.gdb import Gdb, GdbError, frame


def serve(script):
    """One-connection server; script(read_packet, send) drives it."""
    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)

    def run():
        c, _ = srv.accept()
        buf = b""

        def read():
            nonlocal buf
            while True:
                i = buf.find(b"#")
                if buf.startswith(b"+") or buf.startswith(b"-"):
                    buf = buf[1:]; continue
                if buf[:1] == b"\x03":
                    buf = buf[1:]; return "\x03"
                if i >= 0 and len(buf) >= i + 3:
                    body, buf = buf[1:i].decode(), buf[i + 3:]; return body
                d = c.recv(4096)
                if not d:
                    return None
                buf += d
        script(read, lambda p: c.sendall(frame(p)), c)
        c.close(); srv.close()
    threading.Thread(target=run, daemon=True).start()
    return srv.getsockname()[1]


def test_request_resume_interrupt_and_lost():
    def script(read, send, c):
        assert read() == "?"; send("T05core:01;")
        assert read() == "p0"; send("2a000000")
        assert read() == "c"; send("O68656c6c6f")  # console output is not a stop
        assert read() == "\x03"; send("T02")
        assert read() == "s"; send("T05")
        assert read() == "p0"; c.close()  # dies mid-request
    port = serve(script)
    stops = queue.Queue()
    lost = queue.Queue()
    g = Gdb("127.0.0.1", port, stops.put, lambda: lost.put(1))
    assert g.request("?") == "T05core:01;"
    assert g.request("p0") == "2a000000"
    g.resume("c")
    g.interrupt()
    assert stops.get(timeout=3) == "T02"
    assert g.resume("s", wait=True) == "T05"
    with pytest.raises(GdbError, match="Lost"):
        g.request("p0")
    assert lost.get(timeout=3) == 1


def test_connection_refused_in_plain_words():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    with pytest.raises(GdbError, match="refused"):
        Gdb("127.0.0.1", port, print, print)


def test_unanswered_request_gives_the_connection_up():
    """Replies carry no request id: after a timeout a late reply could answer the next request, so the connection is closed and reported lost."""
    def script(read, send, c):
        assert read() == "p0"  # never answered
        assert read() is None  # the client closed the socket
    port = serve(script)
    lost = queue.Queue()
    g = Gdb("127.0.0.1", port, print, lambda: lost.put(1))
    with pytest.raises(GdbError, match="did not answer"):
        g.request("p0", timeout=0.2)
    assert lost.get(timeout=3) == 1 and g.closed
    with pytest.raises(GdbError):
        g.request("p0")


def test_resume_can_be_vetoed_under_the_pause_lock():
    """`before` decides at the moment the resume would start; vetoed, nothing is sent and a synthetic SIGINT stop comes back."""
    def script(read, send, c):
        assert read() == "p0"  # the vetoed `c` never arrived
        send("2a000000")
    port = serve(script)
    g = Gdb("127.0.0.1", port, print, print)
    assert g.resume("c", wait=True, before=lambda: False) == "T02" and not g.running
    assert g.request("p0") == "2a000000"


def test_a_stop_that_races_the_waiters_timeout_is_not_dropped():
    """The stop arrives after the waiter's get timed out but before it handed over: it is returned to the waiter; one after the handover goes to on_stop."""
    port = serve(lambda read, send, c: read())
    stops = []
    g = Gdb("127.0.0.1", port, stops.append, print)

    class Racy(queue.Queue):
        def get(self, block=True, timeout=None):  # the stop is routed into this queue just as the waiter gives up
            if block:
                g._packet("T05")
                raise queue.Empty
            return super().get(block=False)

    g.running = True
    q = Racy()
    g.sync = q
    assert g.wait_stop(q, 0.01) == "T05" and not stops
    g.running = True
    q2 = g.arm()
    with pytest.raises(GdbError, match="did not stop"):
        g.wait_stop(q2, 0.01)
    g._packet("T05")  # after the handover: on_stop gets it
    assert stops == ["T05"]
