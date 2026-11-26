"""Error codes (protocol.md "Errors"), RpcError, and the Java-exception mapping."""
import sys

NO_PROGRAM, CANCELLED, TIMEOUT, NOT_FOUND, BUSY, INTERNAL, NO_METHOD, INVALID = -32001, -32002, -32003, -32004, -32005, -32603, -32601, -32602
PROJECT_LOCKED = -32006
# Ghidra exceptions that mean "the caller's arguments are wrong" (-> InvalidArgument); anything else Java throws is Internal
INVALID_JAVA = {"InvalidInputException", "DuplicateNameException", "ParseException", "InvalidDataTypeException",
                "IllegalArgumentException", "CancelledException", "UsrException", "AddressOutOfBoundsException",
                "LoadException", "LanguageNotFoundException", "CompilerSpecNotFoundException", "InvalidNameException"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def java_error(e):
    """jpype.JException -> RpcError (InvalidArgument for the exceptions in INVALID_JAVA, else Internal)."""
    kind = str(e.getClass().getSimpleName())
    return RpcError(INVALID if kind in INVALID_JAVA else INTERNAL, str(e.getMessage() or kind))
