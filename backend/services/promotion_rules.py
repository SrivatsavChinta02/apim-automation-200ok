"""Codified cross-environment transformation rules for APIM promotion.

Implements deterministic dev→prod rules extracted from AI_PROMOTION_RULES.txt.

Direction scope: Only dev→prod is implemented. If (src_env, dest_env) is any
other combination, all functions return the input unchanged. This is intentional
— other directions (e.g. sandbox→prod) will be added in a later task.

Rules:
  Rule 1 — Azure OpenAI: hostname -np[digits] → -pd[digits]
            Special overrides (bare -np with non-standard prod suffix) are
            consulted before the general regex.
  Rule 2 — Cognizant internal: env indicator removal (fixed dict lookup)
  Rule 3 — External services: hosts not on *.cognizant.com / *.azure.com pass
            through unchanged.
  Rule 4 — API ID prefix transforms (fixed dict lookup)
  Edge    — AI Foundry hosts have no prod equivalent; transform_host returns
            None to signal "needs user input."
"""
import re
from urllib.parse import urlparse, urlunparse

# ---------------------------------------------------------------------------
# Rule 1 — Azure OpenAI regex + special-case overrides
# ---------------------------------------------------------------------------

# General pattern: openai-<name>-np[digits].openai.azure.com
_OPENAI_NP_RE = re.compile(
    r"^(openai-[^.]+?)-np(\d*)\.openai\.azure\.com$"
)

# Hardcoded overrides: bare -np hosts whose prod suffix differs from plain -pd.
# Only the HOSTNAME part (no domain).
_OPENAI_NP_OVERRIDES: dict[str, str] = {
    # openai-enhsch-np → openai-enhsch-pd01  (bare -np upgrades to -pd01)
    "openai-enhsch-np.openai.azure.com": "openai-enhsch-pd01.openai.azure.com",
}

# ---------------------------------------------------------------------------
# AI Foundry — no prod mapping; transform_host must return None
# ---------------------------------------------------------------------------

_AI_FOUNDRY_NO_PROD: frozenset[str] = frozenset({
    "ai-foundry-1caiassist-np.services.ai.azure.com",
    "ai-foundry-1caiassist-np01.services.ai.azure.com",
    "ai-foundry-1caiassist-np01.openai.azure.com",
    "ai-foundry-1caiassist-np.openai.azure.com",
})

# ---------------------------------------------------------------------------
# Rule 2 — Cognizant internal: fixed host lookup
# ---------------------------------------------------------------------------

_COGNIZANT_HOST_MAP: dict[str, str] = {
    "indev.docstorage.cognizant.com": "in.docstorage.cognizant.com",
    "onecdevintaksbcappsapi.cognizant.com": "onecognizantaksbcappsapi.cognizant.com",
    "onecsitaksbcappsapi.cognizant.com": "onecognizantaksbcappsapi.cognizant.com",
    "onecuataksbcappsapi.cognizant.com": "onecognizantaksbcappsapi.cognizant.com",
}

# ---------------------------------------------------------------------------
# Rule 4 — API ID prefix transforms
# ---------------------------------------------------------------------------

_API_ID_MAP: dict[str, str] = {
    "storage-document": "4361-storage-document",
    "mycontracts-dev": "757-mycontracts",
    "mycontracts-SIT": "757-mycontracts",
    "mycontracts": "757-mycontracts",
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def is_external(host: str) -> bool:
    """Return True if host is an external service (not *.cognizant.com / *.azure.com).

    External hosts are passed through unchanged during promotion.
    """
    if not host:
        return True
    return not (
        host.endswith(".cognizant.com")
        or host == "cognizant.com"
        or host.endswith(".azure.com")
        or host == "azure.com"
    )


def transform_host(host: str, src_env: str, dest_env: str) -> str | None:
    """Transform a backend hostname from src_env to dest_env.

    Returns:
      - Transformed hostname string when a rule applies.
      - The original hostname when no transformation is needed (external, or
        no matching rule).
      - None when the host is known to have NO prod equivalent (AI Foundry);
        the caller must prompt the user.

    For any (src_env, dest_env) other than ("dev", "prod") the input is
    returned unchanged.
    """
    if (src_env, dest_env) != ("dev", "prod"):
        return host

    if not host:
        return host

    # AI Foundry — no prod mapping
    if host in _AI_FOUNDRY_NO_PROD:
        return None

    # Rule 1 special-case overrides (checked before regex)
    if host in _OPENAI_NP_OVERRIDES:
        return _OPENAI_NP_OVERRIDES[host]

    # Rule 1 general regex
    m = _OPENAI_NP_RE.match(host)
    if m:
        prefix, digits = m.group(1), m.group(2)
        return f"{prefix}-pd{digits}.openai.azure.com"

    # Rule 2 Cognizant internal
    if host in _COGNIZANT_HOST_MAP:
        return _COGNIZANT_HOST_MAP[host]

    # Rule 3 external — pass through unchanged
    if is_external(host):
        return host

    # No rule matched for a known internal host — return unchanged
    return host


def transform_api_id(api_id: str, src_env: str, dest_env: str) -> str:
    """Transform an API ID from src_env to dest_env (Rule 4).

    Returns the transformed API ID, or the original if no rule matches.
    For non-dev→prod directions the input is returned unchanged.
    """
    if (src_env, dest_env) != ("dev", "prod"):
        return api_id
    return _API_ID_MAP.get(api_id, api_id)


def transform_url(url: str, src_env: str, dest_env: str) -> str | None:
    """Transform a full URL's hostname from src_env to dest_env.

    Path, query string, and fragment are preserved.

    Returns:
      - Transformed URL string when a rule applies or host passes through.
      - Empty string when url is empty.
      - None when the host maps to None (AI Foundry / needs user input).

    For non-dev→prod directions the input is returned unchanged.
    """
    if not url:
        return url

    if (src_env, dest_env) != ("dev", "prod"):
        return url

    parsed = urlparse(url)
    host = parsed.hostname or ""

    new_host = transform_host(host, src_env, dest_env)

    if new_host is None:
        return None

    if new_host == host:
        return url

    # Rebuild netloc (preserve port if present)
    netloc = new_host
    if parsed.port:
        netloc = f"{new_host}:{parsed.port}"

    return urlunparse(parsed._replace(netloc=netloc))


def build_substitution_map(
    src_hosts: "set[str] | list[str]",
    src_env: str,
    dest_env: str,
) -> dict[str, str]:
    """Return {src_host: dest_host} for hosts where transformation is unambiguous.

    Skips hosts where transform_host returns:
      - None  (no prod equivalent; needs user input)
      - The original host unchanged (no rewrite needed — external or no rule)
    """
    result: dict[str, str] = {}
    for host in src_hosts:
        dest = transform_host(host, src_env, dest_env)
        if dest is None:
            continue  # needs user input
        if dest == host:
            continue  # no rewrite needed
        result[host] = dest
    return result
