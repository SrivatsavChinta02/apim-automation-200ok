"""Policy XML diff lint via Anthropic.

Pre-flight check that runs before update_api_policy / update_operation_policy
tool calls. Asks Sonnet to identify whether the proposed XML adds duplicates
or conflicts vs the current policy. Returns a structured conflict list that
the chat LLM can surface to the user as a "did you mean?" prompt.

Fail-closed: any error (network, malformed JSON, missing key) blocks the
mutation by surfacing diff_failed=True so the caller treats it as a hard stop.
"""
import json
from utils.logger import get_logger

log = get_logger(__name__)


_DIFF_SYSTEM_PROMPT = """You are a policy XML diff analyzer for Azure APIM.

Given the CURRENT policy XML and a PROPOSED new policy XML, identify whether
the proposed change duplicates or conflicts with existing policy elements.

Return strict JSON in this exact shape (no prose, no markdown fences):
{
  "conflicts": [
    {
      "element": "<element-tag-name>",
      "scope": "inbound" | "backend" | "outbound" | "on-error",
      "existing": { ...attributes/values from current... },
      "proposed": { ...attributes/values from proposed... },
      "action": "duplicate" | "config_conflict",
      "summary": "<short human-readable description>"
    }
  ]
}

A "duplicate" is when the proposed XML adds an element whose semantic role is
already played by an existing element (e.g. two <validate-jwt> blocks, or two
<rate-limit-by-key> blocks with the same counter-key). A "config_conflict" is
when the same logical element exists in both with different attributes that
matter (e.g. different audience for validate-jwt, different calls/period
for rate-limit).

Focus on these element types only:
- validate-jwt
- rate-limit, rate-limit-by-key
- quota, quota-by-key
- ip-filter
- check-header
- cors
- authentication-basic, authentication-managed-identity, authentication-certificate
- set-header (when name attribute matches)
- set-backend-service

Do NOT flag <base />, <set-variable>, <choose>, <return-response>, or other
control-flow constructs. Do NOT flag the consumer-name allowlist <choose>
block (it is managed idempotently by a separate helper).

If there are no conflicts, return {"conflicts": []}. Always return valid JSON.
"""


def analyze_policy_change(current_xml: str, new_xml: str, anthropic_client) -> dict:
    """Run the policy diff. Returns:
        {"conflicts": [...]} on success (list may be empty)
        {"diff_failed": True, "error": "<reason>"} on any failure (caller halts)
    """
    if not anthropic_client:
        return {"diff_failed": True, "error": "Anthropic client not available"}
    if not new_xml:
        return {"diff_failed": True, "error": "Proposed XML is empty"}
    if not current_xml:
        # No existing policy to conflict with — proceed.
        return {"conflicts": []}

    user_content = (
        f"CURRENT policy XML:\n```xml\n{current_xml}\n```\n\n"
        f"PROPOSED new policy XML:\n```xml\n{new_xml}\n```\n\n"
        "Analyze and return JSON per the system prompt."
    )

    try:
        msg = anthropic_client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=2048,
            system=_DIFF_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text").strip()
    except Exception as e:
        log.warning("policy_diff_api_error", extra={"error": str(e)})
        return {"diff_failed": True, "error": f"Policy diff API call failed: {e}"}

    # Strip ```json fences if Sonnet adds them despite the prompt
    if text.startswith("```"):
        text = text.strip("`").lstrip("json").strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        log.warning("policy_diff_bad_json", extra={"text": text[:500], "error": str(e)})
        return {"diff_failed": True, "error": "Policy diff returned malformed JSON"}

    conflicts = parsed.get("conflicts")
    if not isinstance(conflicts, list):
        log.warning("policy_diff_bad_shape", extra={"parsed": parsed})
        return {"diff_failed": True, "error": "Policy diff response missing conflicts array"}

    return {"conflicts": conflicts}
