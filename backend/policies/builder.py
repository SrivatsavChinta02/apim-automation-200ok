import os
import re

TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "templates")
_PLACEHOLDER_RE = re.compile(r"[A-Z][A-Z0-9_]*_PLACEHOLDER")


class PolicyBuildError(Exception):
    pass


class PolicyBuilder:
    def __init__(self, xml: str):
        self._xml = xml
        self._substitutions: dict[str, str] = {}

    @classmethod
    def from_template(cls, template_name: str) -> "PolicyBuilder":
        path = os.path.join(TEMPLATES_DIR, f"{template_name}.xml")
        with open(path, "r", encoding="utf-8") as f:
            return cls(f.read())

    def set(self, placeholder: str, value) -> "PolicyBuilder":
        # Coerce to str: callers may pass ints (rate/quota counts), and
        # str.replace() in build() rejects non-str second args.
        self._substitutions[placeholder] = str(value)
        return self

    def build(self) -> str:
        result = self._xml
        for placeholder, value in self._substitutions.items():
            result = result.replace(placeholder, value)
        remaining = _PLACEHOLDER_RE.findall(result)
        if remaining:
            raise PolicyBuildError(f"Unfilled placeholders: {remaining}")
        return result
