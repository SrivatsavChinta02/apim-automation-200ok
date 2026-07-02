"""Tool registry for the analytical assistant.

Each tool is a Tool() dataclass:
- name: str (tool name visible to LLM)
- description: str (what it does, for LLM to decide when to use)
- input_schema: dict (JSON schema for params)
- handler: callable (env, **args) -> dict | list  (raw return)
- mutates: bool (default False)
- requires_password: bool (default False - Phase 3C only)
"""
from dataclasses import dataclass
from typing import Callable


@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict
    handler: Callable
    mutates: bool = False
    requires_password: bool = False
    cacheable: bool = True

    def to_anthropic(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


# Module-level registry populated by tool modules at import time
REGISTRY: dict[str, Tool] = {}


def register(tool: Tool) -> Tool:
    REGISTRY[tool.name] = tool
    return tool


def get_anthropic_tools() -> list[dict]:
    return [t.to_anthropic() for t in REGISTRY.values()]


def get_tool(name: str) -> Tool | None:
    return REGISTRY.get(name)


# Trigger registration via import side effects
from . import read  # noqa: F401, E402
from . import mutate  # noqa: F401, E402  — registered after read
from . import destructive  # noqa: F401, E402  — registered after mutate
