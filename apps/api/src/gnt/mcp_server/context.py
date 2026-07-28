from contextvars import ContextVar

current_org_id: ContextVar[str | None] = ContextVar("current_org_id", default=None)
current_key_id: ContextVar[str | None] = ContextVar("current_key_id", default=None)


def require_org_id() -> str:
    org_id = current_org_id.get()
    if org_id is None:
        raise RuntimeError("no authenticated org for this MCP request")
    return org_id


def require_key_id() -> str:
    key_id = current_key_id.get()
    if key_id is None:
        raise RuntimeError("no authenticated api key for this MCP request")
    return key_id
