class OpError(Exception):
    """An operation failure with a machine-readable code understood by the server."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
