"""Headless recovery snapshots for the sidecar's saved ProgramDB objects."""


def take_recovery_snapshot(prog):
    """Return Ghidra's success status: a snapshot was written or the DB was already current.

    The caller holds the save lock and runs on R with background analysis disabled, so no
    transactions can start while we snapshot. The DB checks for an active transaction itself.
    Calling through the domain object's save or snapshot lock would prepare metadata in a
    transaction or require a GUI. Use the same DB handle and change set as GhidraFileData.
    """
    from ghidra.util.task import TaskMonitor

    if not prog.canSave() or prog.isLocked():
        return False
    return bool(prog.getDBHandle().takeRecoverySnapshot(prog.getChangeSet(), TaskMonitor.DUMMY))
