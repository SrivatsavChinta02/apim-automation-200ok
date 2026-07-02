"""Agentic tool-use loop for the analytical assistant.

Phase 3B/3C: worker thread drives the loop and pushes events to a per-session
queue; the SSE generator just drains the queue. Mutating + destructive tools
pause on a confirmation gate so the user can review before execution.

Hard limits:
- 70 tool calls per conversation turn
- per-tool timeout 60s
"""
import json
import os
import time
import hmac
import threading
import queue as _queue
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from utils.logger import get_logger
from .tools import get_anthropic_tools, get_tool
from .tools import cache as tool_cache
from . import analyze_state

log = get_logger(__name__)

MAX_TOOL_CALLS = 70
TOOL_TIMEOUT_S = 60

ANALYZE_SYSTEM_PROMPT = """You are an Azure APIM admin assistant. The user has asked an analytical question - you have a toolbox of read-only API inspection tools. Use them to answer.

## Style

- Compose the answer in clear prose. Use markdown tables when listing 3+ items with multiple fields.
- Be specific: include API ids, paths, revision numbers, etc. Don't paraphrase data.
- If a tool returns an error, report the error verbatim to the user in 1-2 short sentences and STOP. Do NOT speculate about infrastructure, suggest restarts, propose admin actions, offer to "try a different environment", or attempt diagnostic theories. The user will read the error and act on it themselves. You are not an SRE.
- Do not suggest the user "check service health", "ping admin", or similar troubleshooting steps. The error message is the answer.
- If a required tool parameter is missing or ambiguous from the user's query AND from the conversation history, ASK the user in ONE SHORT question before calling any tool. Do NOT default-fill. The most common missing param is `env` (dev/sandbox/prod/dr).
  Examples:
    user: "find apis whose policy has rate-limit"     → ask: "Which env? (dev / sandbox / prod / dr)"
    user: "rotate primary key for sub-test"           → ask: "Which env should I check sub-test in?"
    user: "list named values"                         → ask: "Which env?"
  Once the user answers, the next turn re-receives the question with full context — proceed with tool calls then.
- If you have ALL the data you need from one round of tool calls, answer; don't call more tools just to be thorough.
- Parallelize where possible: if you need to inspect 5 APIs, return 5 tool_use blocks in ONE response - they will execute concurrently.
- HARD CAP: at most 70 tool calls per turn. If the question would need more, answer with what you have and note that more inspection is needed.

## Mutations & deletions — IMPORTANT

When the user asks for a mutation or deletion, **CALL THE TOOL DIRECTLY** with proper arguments. The system intercepts every mutating/destructive tool call BEFORE execution and shows the user a confirmation chip (with a password prompt for delete_*). You DO NOT collect confirmation or password yourself — the runtime does that. Your job is to propose the tool call; the runtime gates it.

- Available mutating tools: update_*, create_*, regenerate_*, add_operation, update_subscription_state, update_backend_url, promote_api, upload_certificate, upload_ca_certificate
- Available destructive tools: delete_subscription, delete_named_value, delete_operation, delete_api, delete_backend, delete_certificate, delete_ca_certificate
- DO NOT respond with "I need the admin password to proceed" or "do you want me to do this" — that is the runtime's job. Just call the tool.
- After the user cancels, you'll see `{"error": "user_cancelled"}` in the tool_result. After invalid password, `{"error": "admin_password_invalid"}`. Acknowledge in your final message and stop.
- When the user names a specific resource and asks to delete/update/rotate it (e.g. "delete sub-101", "rotate keys for sub-foo"), trust them and CALL the tool directly. Don't pre-check with list_* unless the user explicitly says "first show me ..." — the runtime's confirmation chip is the verification step. Pre-checking turns a 1-tool delete into a 2-tool round-trip and blocks the gate from firing if the resource happens to be missing.
- **Typos and partial names are AUTO-CORRECTED by the runtime.** Before any destructive tool gates, a pre-flight resolver fuzzy-matches the id against the env's resource list — `petsotre` → `my-petstore`, `petfn` → `petfan`, `cert demo` → `CertDemo`, etc. **You do NOT need to call list_* first to verify the spelling.** Just call the tool with the user's literal phrasing for the id; the runtime corrects typos and either (a) silently swaps in the real id, (b) asks the user to disambiguate via a candidates list when 2+ matches, or (c) returns a not_found error with suggestions. Do not second-guess fuzzy/typo'd ids — call the tool and let pre-flight do its job.
- If the tool returns `{"error": "not_found", "candidates": [...]}`, surface the candidates to the user as suggestions. If `{"error": "Multiple X match", "candidates": [...]}`, ask the user which one. Otherwise just acknowledge and stop.

## Circuit Breaker Configuration — IMPORTANT

For `update_circuit_breaker`:
- **ALWAYS ask the user for failure_count, interval_seconds, and trip_duration_seconds BEFORE calling the tool** if these values were not explicitly provided in their query.
- Ask in ONE SHORT question: "Failure count? Interval (seconds)? Trip duration (seconds)?"
- Do NOT use default values (5, 60, 30) without user confirmation.
- Once the user provides the values, call the tool with those parameters.

## Revision policy — IMPORTANT

For tools that mutate API-level or operation-level policy (`update_api_policy`, `update_operation_policy`):
- **ALWAYS ask the user FIRST** "Should I apply this in place or save it as a new revision?" before proposing the tool call.
- Forward the answer in the `as_new_revision` parameter: `true` = clone current rev, patch the new rev, release it as current (rollback-friendly, audit trail). `false` = patch current rev in place (no audit, faster).
- Never default — let the user choose. Recommended phrasing: "Want me to apply this change in place or save as a new revision (rev N+1)?"
- For `add_operation`: it always creates a new revision internally (api_creator behavior). No need to ask there.
- For `promote_api`: the promote flow always creates a new revision in the destination. No need to ask there either.
- For everything else (backend updates, named values, subscriptions): no revision concept — those resources aren't versioned by API revision.

## Backend cert forwarding (mTLS to backend) — IMPORTANT

Some APIs forward an APIM-stored client cert to their backend via the X-ARR-ClientCert header pattern. Recognise these triggers in user queries:
- "with cert auth", "with mTLS", "client cert to backend", "forward cert"
- "use cert <some-id>", "with thumbprint <hex>"

When the user wants this:
1. If they reference an EXISTING cert by id/name/thumbprint → call list_certificates first (or get_certificate) to confirm the thumbprint, then pass `backend_cert_thumbprint` to create_api_flow.
2. If they want to UPLOAD a new cert → ask them to paste the base64-encoded PFX and the password, then call upload_certificate (returns thumbprint), then proceed to create_api with that thumbprint.
3. CA certs are independent — only relevant if user explicitly mentions root/CA cert. Use upload_ca_certificate with store_name="Root" or "CertificateAuthority".

JWT auth is unrelated and ALWAYS configured at API level — both can coexist. Cert forwarding adds the X-ARR-ClientCert header on the way OUT to the backend; JWT validates the caller on the way IN.

## Output

Respond in markdown. The user reads the final text - they will not see the raw tool output. Tables for lists, code-blocks for IDs/paths, prose for context.

- ANSWER ONLY THE QUESTION ASKED. Do NOT add caveats about fields you didn't fetch, data that came back empty, alternative environments to try, or what "could be useful next time". Do NOT explain what you didn't do. If a field came back empty, omit it — don't comment on its emptiness.
- Be terse. A one-sentence intro + a table is usually the entire answer. No "summary of approach" / "here's what I found" framing.
- Never offer to "try the same in a different env" or "expand the search" unless the user explicitly asks.
"""


def _init_anthropic():
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")
    import anthropic
    return anthropic.Anthropic(api_key=api_key)


def _verify_password(supplied):
    if not supplied:
        return False
    expected = os.environ.get("ADMIN_PASSWORD", "")
    if not expected:
        return False
    return hmac.compare_digest(supplied.encode(), expected.encode())


def _execute_tool(tool, args: dict, session_id: str, app, ttl: int = 60):
    """Execute a single tool. Returns (result, from_cache, duration_ms).

    `app` is the Flask app object — we push its context here so this function
    is safe to call from a ThreadPoolExecutor worker (which has its own thread
    and does not inherit the parent's app context).

    Mutating handlers receive `_session_id` so they can invalidate read caches.
    """
    t0 = time.time()
    if tool.cacheable:
        cached = tool_cache.get(session_id, tool.name, args, ttl=ttl)
        if cached is not None:
            return cached, True, int((time.time() - t0) * 1000)
    try:
        if tool.mutates:
            args_with_ctx = {**args, "_session_id": session_id}
        else:
            args_with_ctx = args
        with app.app_context():
            result = tool.handler(**args_with_ctx)
    except Exception as e:
        log.exception("tool execution failed")
        result = {"error": str(e), "exception": type(e).__name__}
    if tool.cacheable and not (isinstance(result, dict) and result.get("error")):
        tool_cache.put(session_id, tool.name, args, result)
    return result, False, int((time.time() - t0) * 1000)


def _summarize_for_chat(tool_name: str, result):
    if isinstance(result, list):
        return f"{tool_name} returned {len(result)} items"
    if isinstance(result, dict):
        if "error" in result:
            return f"{tool_name} failed: {str(result['error'])[:120]}"
        if result.get("ok"):
            return f"{tool_name} ok"
        return f"{tool_name} returned 1 record"
    return f"{tool_name} returned {type(result).__name__}"


def _build_preview(tool, args: dict) -> str:
    """One-line human-readable preview of what this tool call will do."""
    name = tool.name
    if name == "update_operation_policy":
        op = args.get("op_id", "?")
        api = args.get("api_id", "?")
        env = args.get("env", "?")
        xml_len = len(args.get("new_xml", ""))
        return f"Replace operation policy on {env}/{api}/{op} with new XML ({xml_len} chars)"
    if name == "update_api_policy":
        return f"Replace API-level policy on {args.get('env')}/{args.get('api_id')} ({len(args.get('new_xml',''))} chars)"
    if name in ("update_named_value", "create_named_value"):
        secret = args.get("secret", False)
        return f"Set {args.get('env')}/namedValues/{args.get('nv_id')} = {'<masked>' if secret else args.get('value','')[:40]}"
    if name == "update_subscription_state":
        return f"Set subscription {args.get('env')}/{args.get('sub_id')} state -> {args.get('state')}"
    if name == "regenerate_subscription_keys":
        return f"Regenerate {args.get('which', 'primary')} key for {args.get('env')}/{args.get('sub_id')}"
    if name == "update_backend_url":
        return f"Update backend {args.get('env')}/{args.get('backend_id')} url -> {args.get('new_url')}"
    if name == "add_operation":
        urls = args.get("urls", [])
        return f"Add {len(urls)} op(s) to {args.get('env')}/{args.get('api_id')}"
    if name == "update_circuit_breaker":
        action = "Enable" if args.get("enable", True) else "Disable"
        backend = args.get("backend_id", "?")
        return f"{action} circuit breaker on {backend}"
    if name in ("delete_subscription", "delete_named_value", "delete_operation", "delete_api", "delete_backend"):
        # removeprefix is 3.9+; the project uses 3.13.
        target = next((args.get(k) for k in ("api_id", "sub_id", "nv_id", "backend_id", "op_id") if args.get(k)), "?")
        return f"DELETE {name.removeprefix('delete_')} {args.get('env')}/{target}"
    return f"{name}({', '.join(f'{k}={v}' for k,v in args.items())[:120]})"


# Map tool name -> (arg_key_to_resolve, resolver_function_name).
# Pre-flight resolves resource ids for destructive/mutating tools BEFORE the
# password gate, so the user isn't prompted to confirm deletion of a thing
# that doesn't exist (or a fuzzy-named thing that has multiple candidates).
_PREFLIGHT_RESOLVERS = {
    "delete_product": ("product_id", "resolve_product_id"),
    "update_product": ("product_id", "resolve_product_id"),
    "delete_backend": ("backend_id", "resolve_backend_id"),
    "update_backend": ("backend_id", "resolve_backend_id"),
    "update_backend_url": ("backend_id", "resolve_backend_id"),
    "delete_api": ("api_id", "resolve_api_id"),
    "get_api": ("api_id", "resolve_api_id"),  # Add fuzzy matching for get_api
    "get_api_policy": ("api_id", "resolve_api_id"),  # Add fuzzy matching for get_api_policy
    "list_operations": ("api_id", "resolve_api_id"),  # Add fuzzy matching for list_operations
    "get_operation_policy": ("api_id", "resolve_api_id"),  # Add fuzzy matching for get_operation_policy
    "delete_subscription": ("sub_id", "resolve_sub_id"),
    "update_subscription_state": ("sub_id", "resolve_sub_id"),
    "regenerate_subscription_keys": ("sub_id", "resolve_sub_id"),
    "create_subscription": ("product_id", "resolve_product_id"),
    "update_api": ("api_id", "resolve_api_id"),
    "update_api_policy": ("api_id", "resolve_api_id"),
    "update_operation_policy": ("api_id", "resolve_api_id"),
    "add_operation": ("api_id", "resolve_api_id"),
    "delete_operation": ("api_id", "resolve_api_id"),
    "create_pool": ("api_id", "resolve_api_id"),
    "create_revision": ("api_id", "resolve_api_id"),
    "set_current_revision": ("api_id", "resolve_api_id"),
    "promote_api": ("api_id", "resolve_api_id"),
    "link_api_to_product": ("api_id", "resolve_api_id"),
    "delete_named_value": ("nv_id", "resolve_nv_id"),
    "update_named_value": ("nv_id", "resolve_nv_id"),
    "delete_tag": ("tag_id", "resolve_tag_id"),
    "update_tag": ("tag_id", "resolve_tag_id"),
    "delete_certificate": ("cert_id", "resolve_cert_id"),
    "delete_ca_certificate": ("ca_id", "resolve_ca_cert_id"),
    "get_certificate": ("cert_id", "resolve_cert_id"),
    "get_ca_certificate": ("ca_id", "resolve_ca_cert_id"),
    "list_revisions": ("api_id", "resolve_api_id"),  # Fuzzy match for "APIM Demo" -> "apim-demo"
    "list_versions": ("api_id", "resolve_api_id"),  # Fuzzy match for "APIM Demo" -> "apim-demo"
}


# Op-scoped resolvers: (arg_key_to_resolve, "resolve_op_id"). All entries
# require both env and api_id args; the op_id arg is what gets resolved.
_PREFLIGHT_OP_RESOLVERS = {
    "delete_operation": "op_id",
    "update_operation_policy": "op_id",
    # NOTE: add_operation does NOT belong here — it CREATES new ops, doesn't
    # need to resolve an existing one.
}


def _preflight_resolve_args(tool, args: dict, app) -> dict | None:
    """Try to resolve the resource id arg of a gated tool against the env's
    cached list. Returns:
        None                         — proceed normally (no resolver registered,
                                       resolved in place, or resolver crashed)
        {"error": ..., "candidates": ...} — short-circuit; the gating step is
                                       skipped and this becomes the tool result
    Mutates `args` in place when status == "ok".
    """
    # ── Stage 1: id resolver ──────────────────────────────────────────
    spec = _PREFLIGHT_RESOLVERS.get(tool.name)
    if spec:
        arg_key, resolver_name = spec
        env = args.get("env")
        query = args.get(arg_key)
        if env and query:
            try:
                from services import resource_resolver
                resolver = getattr(resource_resolver, resolver_name)
                with app.app_context():
                    client = app.get_client(env)
                    # For Smart Assistant, use unfiltered API resolution so versioned APIs
                    # like "mycontracts-dev" can be matched directly (LLM explicitly specifies version)
                    if resolver_name == "resolve_api_id":
                        status, value = resolver(env, query, client, filter_versions=False)
                    else:
                        status, value = resolver(env, query, client)
                if status == "ok":
                    if value != query:
                        log.info("preflight_resolved", extra={
                            "tool": tool.name, "arg": arg_key,
                            "from": query, "to": value, "env": env,
                        })
                    args[arg_key] = value  # rewrite resolved id; fall through to policy diff
                elif status == "ambiguous":
                    kind = arg_key.replace("_id", "")
                    return {"error": f"Multiple {kind}s match '{query}' in {env}", "candidates": value}
                elif status == "not_found":
                    kind = arg_key.replace("_id", "")
                    return {"error": f"{kind.capitalize()} '{query}' not found in {env}", "candidates": value}
            except Exception as e:
                log.info("preflight_resolve_failed", extra={"tool": tool.name, "error": str(e)})
                # fall through; policy diff may still need to run

    # ── Stage 1.5: op-scoped id resolver ──────────────────────────────
    op_arg_key = _PREFLIGHT_OP_RESOLVERS.get(tool.name)
    if op_arg_key:
        env = args.get("env")
        api_id = args.get("api_id")
        op_query = args.get(op_arg_key)
        if env and api_id and op_query:
            try:
                from services import resource_resolver
                with app.app_context():
                    client = app.get_client(env)
                    status, value = resource_resolver.resolve_op_id(env, api_id, op_query, client)
                if status == "ok":
                    args[op_arg_key] = value
                elif status == "ambiguous":
                    return {"error": f"Multiple operations match '{op_query}' on {env}/{api_id}", "candidates": value}
                elif status == "not_found":
                    return {"error": f"Operation '{op_query}' not found on {env}/{api_id}", "candidates": value}
            except Exception as e:
                log.info("preflight_op_resolve_failed", extra={"tool": tool.name, "error": str(e)})
                # fall through

    # ── Stage 2: policy diff lint ─────────────────────────────────────
    # Policy diff lint: for update_api_policy / update_operation_policy, ask
    # Sonnet to diff current vs proposed XML and flag duplicates/conflicts.
    # Fail-CLOSED — any diff error blocks the mutation so user can retry.
    if tool.name in ("update_api_policy", "update_operation_policy"):
        from services.policy_diff import analyze_policy_change
        env = args.get("env")
        api_id = args.get("api_id")
        new_xml = args.get("new_xml")
        op_id = args.get("op_id")  # only for update_operation_policy
        log.info("policy_diff_start", extra={
            "tool": tool.name, "env": env, "api_id": api_id,
            "op_id": op_id, "new_xml_len": len(new_xml or ""),
        })
        if not (env and api_id and new_xml):
            log.info("policy_diff_skip_missing_args")
            return None
        try:
            with app.app_context():
                client = app.get_client(env)
                if tool.name == "update_api_policy":
                    status, current_data = client.get(f"apis/{api_id}/policies/policy", rawxml=True)
                else:
                    status, current_data = client.get(
                        f"apis/{api_id}/operations/{op_id}/policies/policy", rawxml=True
                    )
            current_xml = current_data if isinstance(current_data, str) else ""
            log.info("policy_diff_fetched_current", extra={
                "status": status, "current_xml_len": len(current_xml),
                "current_data_type": type(current_data).__name__,
            })
            anthropic = _init_anthropic()
            result = analyze_policy_change(current_xml, new_xml, anthropic)
            log.info("policy_diff_result", extra={
                "diff_failed": result.get("diff_failed"),
                "conflicts_count": len(result.get("conflicts") or []),
            })
        except Exception as e:
            log.warning("policy_diff_preflight_error", extra={"tool": tool.name, "error": str(e)})
            return {
                "ok": False,
                "error": "Could not verify policy change against existing policy. Try again.",
                "diff_failed": True,
            }
        if result.get("diff_failed"):
            return {
                "ok": False,
                "error": result.get("error") or "Policy diff failed",
                "diff_failed": True,
            }
        conflicts = result.get("conflicts") or []
        if conflicts:
            summary_parts = [c.get("summary", c.get("element", "?")) for c in conflicts]
            return {
                "ok": False,
                "error": f"Policy conflict detected: {'; '.join(summary_parts)}. Confirm with the user before proceeding.",
                "conflicts": conflicts,
            }

    return None


def run_analyze_loop(query, history, session_id, app):
    """Top-level entry. Spawns a worker thread, returns an SSE generator
    that yields events from the session's queue."""
    session = analyze_state.get_session(session_id)

    def worker():
        # _drive_loop wraps its own app_context per tool call (because pool
        # workers run in separate threads). The outer worker doesn't need one.
        try:
            _drive_loop(query, history, session_id, session, app)
        except Exception as e:
            log.exception("analyze worker crashed")
            session.event_queue.put({"event": "error", "data": {"message": f"worker crashed: {e}"}})
        finally:
            session.event_queue.put({"event": "__done"})

    t = threading.Thread(target=worker, daemon=True)
    t.start()

    # SSE generator — yield events from queue until __done sentinel
    while True:
        try:
            ev = session.event_queue.get(timeout=300)
        except _queue.Empty:
            yield {"event": "error", "data": {"message": "stream timed out (5 min)"}}
            return
        if ev.get("event") == "__done":
            return
        yield ev


def _drive_loop(query, history, session_id, session, app):
    """Worker-thread inner loop. Drives Anthropic + tool execution, pushes
    events to session.event_queue, blocks on confirmations as needed.

    `app` is forwarded into _execute_tool so each pool worker can acquire
    its own app context (current_app needs that for ApimClient lookup)."""
    try:
        client = _init_anthropic()
    except Exception as e:
        session.event_queue.put({"event": "error", "data": {"message": str(e)}})
        return

    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    tools = get_anthropic_tools()

    messages = list(history or []) + [{"role": "user", "content": query}]
    tool_calls_made = 0
    tools_log = []

    session.event_queue.put({"event": "started", "data": {"session_id": session_id}})

    for iteration in range(MAX_TOOL_CALLS + 2):
        try:
            response = client.messages.create(
                model=model,
                max_tokens=2048,
                system=[{
                    "type": "text",
                    "text": ANALYZE_SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }],
                tools=tools,
                messages=messages,
            )
        except Exception as e:
            log.exception("anthropic call failed in analyze loop")
            session.event_queue.put({"event": "error", "data": {"message": f"LLM call failed: {e}"}})
            return

        tool_uses = [b for b in response.content if getattr(b, "type", None) == "tool_use"]
        text_blocks = [b for b in response.content if getattr(b, "type", None) == "text"]

        if not tool_uses or response.stop_reason == "end_turn":
            final_text = "".join(getattr(b, "text", "") for b in text_blocks).strip()
            session.event_queue.put({
                "event": "final_answer",
                "data": {
                    "text": final_text,
                    "tools_used": tools_log,
                    "iterations": iteration + 1,
                },
            })
            log.info("analyze done", extra={
                "session_id": session_id,
                "iterations": iteration + 1,
                "tool_calls": tool_calls_made,
                "answer_length": len(final_text),
            })
            return

        # Cap check before executing
        if tool_calls_made + len(tool_uses) > MAX_TOOL_CALLS:
            allowed = MAX_TOOL_CALLS - tool_calls_made
            session.event_queue.put({
                "event": "error",
                "data": {
                    "message": f"Hit hard cap of {MAX_TOOL_CALLS} tool calls. LLM wanted {len(tool_uses)} more but only {allowed} allowed. Forcing final answer.",
                },
            })
            messages.append({"role": "assistant", "content": response.content})
            # Anthropic API requires every tool_use to have a matching tool_result.
            # Skip all pending tool_uses with a cap-exceeded sentinel, then append
            # the instruction to finalize the answer.
            cap_blocks = [
                {"type": "tool_result", "tool_use_id": tu.id,
                 "content": f"skipped: hit hard cap of {MAX_TOOL_CALLS} tool calls",
                 "is_error": True}
                for tu in tool_uses
            ]
            cap_blocks.append({
                "type": "text",
                "text": f"You've reached the hard cap of {MAX_TOOL_CALLS} tool calls. Answer the user with what you have so far. No more tool calls.",
            })
            messages.append({"role": "user", "content": cap_blocks})
            continue

        # Categorize tool uses
        results_by_id = {}
        gated_uses = []     # need confirmation
        readonly_uses = []  # execute immediately

        for tu in tool_uses:
            tool = get_tool(tu.name)
            if tool is None:
                results_by_id[tu.id] = {"error": f"tool '{tu.name}' not found"}
                session.event_queue.put({
                    "event": "tool_call_done",
                    "data": {"id": tu.id, "tool": tu.name, "args": tu.input, "summary": "unknown tool", "duration_ms": 0},
                })
                continue

            # Pre-flight resolver: resolve resource ids for tools that have a resolver
            # registered. For mutating tools, this runs before password prompt. For
            # read tools, it enables fuzzy matching (e.g., "mycontracts" -> "757-MyContracts").
            preflight = _preflight_resolve_args(tool, tu.input or {}, app)
            if preflight is not None:
                # Resolution failed (not_found or ambiguous)
                results_by_id[tu.id] = preflight
                summary = preflight.get("error", "resolution failed")
                session.event_queue.put({
                    "event": "tool_call_done",
                    "data": {"id": tu.id, "tool": tu.name, "args": tu.input, "summary": summary, "duration_ms": 0},
                })
                continue

            if tool.mutates or tool.requires_password:
                gated_uses.append((tu, tool))
            else:
                readonly_uses.append((tu, tool))

        # Execute read-only tools in parallel (existing behavior)
        if readonly_uses:
            with ThreadPoolExecutor(max_workers=min(len(readonly_uses), 8)) as pool:
                futures = {}
                for tu, tool in readonly_uses:
                    session.event_queue.put({
                        "event": "tool_call_start",
                        "data": {"id": tu.id, "tool": tu.name, "args": tu.input},
                    })
                    futures[pool.submit(_execute_tool, tool, tu.input or {}, session_id, app)] = tu
                for fut in as_completed(futures):
                    tu = futures[fut]
                    try:
                        result, from_cache, duration_ms = fut.result(timeout=TOOL_TIMEOUT_S)
                    except Exception as e:
                        result, from_cache, duration_ms = {"error": str(e)}, False, 0
                    results_by_id[tu.id] = result
                    tool_calls_made += 1
                    summary = _summarize_for_chat(tu.name, result)
                    if from_cache:
                        summary += " (cached)"
                    tools_log.append({
                        "tool": tu.name,
                        "tool_args": tu.input,
                        "summary": summary,
                        "duration_ms": duration_ms,
                        "from_cache": from_cache,
                    })
                    log.info("tool_call", extra={
                        "session_id": session_id,
                        "tool": tu.name,
                        "tool_args": tu.input,
                        "duration_ms": duration_ms,
                        "from_cache": from_cache,
                        "result_summary": summary,
                    })
                    session.event_queue.put({
                        "event": "tool_call_done",
                        "data": {
                            "id": tu.id,
                            "tool": tu.name,
                            "args": tu.input,
                            "summary": summary,
                            "duration_ms": duration_ms,
                            "from_cache": from_cache,
                        },
                    })

        # Handle gated tools: emit confirmation request, block, then execute or skip
        if gated_uses:
            batch_id = f"conf-{uuid.uuid4().hex[:12]}"
            batch_descriptors = []
            requires_password = False
            for tu, tool in gated_uses:
                preview = _build_preview(tool, tu.input or {})
                batch_descriptors.append({
                    "tool_use_id": tu.id,
                    "name": tu.name,
                    "args": tu.input or {},
                    "mutates": tool.mutates,
                    "requires_password": tool.requires_password,
                    "preview": preview,
                })
                if tool.requires_password:
                    requires_password = True

            session.event_queue.put({
                "event": "tool_confirmation_required",
                "data": {
                    "batch_id": batch_id,
                    "tools": batch_descriptors,
                    "requires_password": requires_password,
                },
            })

            # Block until /confirm resolves
            confirmation = analyze_state.request_confirmation(session_id, batch_id, batch_descriptors)
            decision = confirmation.get("decision", "cancel")
            password = confirmation.get("password")

            if decision == "cancel":
                # Mark all gated tools as cancelled
                for tu, _t in gated_uses:
                    results_by_id[tu.id] = {"error": "user_cancelled", "cancelled": True}
                    tool_calls_made += 1
                    session.event_queue.put({
                        "event": "tool_call_done",
                        "data": {
                            "id": tu.id, "tool": tu.name, "args": tu.input,
                            "summary": "cancelled by user", "duration_ms": 0,
                        },
                    })
                    tools_log.append({
                        "tool": tu.name, "tool_args": tu.input,
                        "summary": "cancelled by user", "duration_ms": 0, "from_cache": False,
                    })
                    log.info("tool_cancelled", extra={"session_id": session_id, "tool": tu.name})
            else:
                # Verify password if any tool in the batch needs it
                password_ok = True
                if requires_password and not _verify_password(password):
                    password_ok = False
                    log.warning("admin_password_failed", extra={"session_id": session_id, "batch_id": batch_id})
                    for tu, _t in gated_uses:
                        results_by_id[tu.id] = {"error": "admin_password_invalid"}
                        tool_calls_made += 1
                        session.event_queue.put({
                            "event": "tool_call_done",
                            "data": {
                                "id": tu.id, "tool": tu.name, "args": tu.input,
                                "summary": "REJECTED: invalid admin password", "duration_ms": 0,
                            },
                        })
                        tools_log.append({
                            "tool": tu.name, "tool_args": tu.input,
                            "summary": "rejected: invalid admin password", "duration_ms": 0, "from_cache": False,
                        })

                if password_ok:
                    # Execute gated tools sequentially (safer than parallel for mutations)
                    for tu, tool in gated_uses:
                        session.event_queue.put({
                            "event": "tool_call_start",
                            "data": {"id": tu.id, "tool": tu.name, "args": tu.input},
                        })
                        try:
                            result, _from_cache, duration_ms = _execute_tool(tool, tu.input or {}, session_id, app)
                        except Exception as e:
                            result, duration_ms = {"error": str(e)}, 0
                        results_by_id[tu.id] = result
                        tool_calls_made += 1
                        summary = _summarize_for_chat(tu.name, result)
                        tools_log.append({
                            "tool": tu.name, "tool_args": tu.input,
                            "summary": summary, "duration_ms": duration_ms, "from_cache": False,
                        })
                        log.info("tool_call_mutate", extra={
                            "session_id": session_id, "tool": tu.name, "tool_args": tu.input,
                            "duration_ms": duration_ms, "result_summary": summary,
                        })
                        session.event_queue.put({
                            "event": "tool_call_done",
                            "data": {
                                "id": tu.id, "tool": tu.name, "args": tu.input,
                                "summary": summary, "duration_ms": duration_ms, "from_cache": False,
                            },
                        })

        # Feed results back to LLM
        messages.append({"role": "assistant", "content": response.content})
        tool_results_content = []
        for tu in tool_uses:
            result_str = json.dumps(results_by_id.get(tu.id, {"error": "no result"}), default=str)
            if len(result_str) > 30000:
                result_str = result_str[:30000] + '..."[truncated]"'
            tool_results_content.append({
                "type": "tool_result",
                "tool_use_id": tu.id,
                "content": result_str,
            })
        messages.append({"role": "user", "content": tool_results_content})

    session.event_queue.put({"event": "error", "data": {"message": "analyze loop did not converge"}})
