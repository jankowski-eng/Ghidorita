"""Wiring: the context, the domains, and their registered RPCs. A new domain module is added to DOMAINS below; a new RPC in an
existing domain needs nothing here."""
from .core.context import Ctx
from .core.rpc import Dispatcher, Registry
from .core.server import Server
from .domains.datatypes import DataTypes
from .domains.decompile import Decompile
from .domains.edits import Edits
from .domains.highvars import HighVars
from .domains.listing import Listing
from .domains.program import Program
from .domains.project import Project
from .domains.search import Search
from .domains.xrefs import Xrefs

DOMAINS = (Listing, Decompile, Edits, HighVars, Search, Xrefs, DataTypes)  # Project and Program are built first, the others only need ctx


class App:
    def __init__(self, start=True):
        """start=False: no threads (test_methods.py builds the registry without a JVM)."""
        self.ctx = ctx = Ctx()
        ctx.project = Project(ctx)  # part of the context: Program opens programs through it
        program = Program(ctx)
        self.registry = Registry()
        self.domains = (ctx.project, program, *(d(ctx) for d in DOMAINS))  # kept for tests that call the methods in-process
        for dom in self.domains:
            self.registry.register(dom)
        ctx.shutdown_hooks += [program.close, ctx.project.close]  # autosave the program on R, then release the project lock files
        self.server = Server(ctx, Dispatcher(ctx, self.registry).handle)
        if start:
            ctx.lanes.start()
            program.start()
