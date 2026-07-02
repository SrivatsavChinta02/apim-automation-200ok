"""Service for comparing APIs between APIM instances."""

import re
import difflib
from utils.policy_xml import extract_backend_ids

BUILTIN_APIS = {"echo-api"}


def _strip_revision(name: str) -> str:
    """Remove ;rev=N suffix from an API name."""
    return re.sub(r";rev=\d+", "", name)


def _deduplicate_apis(api_list: list) -> dict:
    """Deduplicate APIs by stripped name, keeping first occurrence. Filter builtins."""
    seen = {}
    for api in api_list:
        clean_name = _strip_revision(api.get("name", ""))
        if not clean_name:
            continue
        if clean_name in BUILTIN_APIS:
            continue
        if clean_name not in seen:
            seen[clean_name] = api
    return seen


def _unified_diff(src_text, dest_text):
    """Return list of {line, type} where type is 'add','remove','context'."""
    src_lines = (src_text or "").splitlines()
    dest_lines = (dest_text or "").splitlines()
    result = []
    matcher = difflib.SequenceMatcher(None, src_lines, dest_lines, autojunk=False)
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            for line in src_lines[i1:i2]:
                result.append({"line": line, "type": "context"})
        elif op == "insert":
            for line in dest_lines[j1:j2]:
                result.append({"line": line, "type": "add"})
        elif op == "delete":
            for line in src_lines[i1:i2]:
                result.append({"line": line, "type": "remove"})
        elif op == "replace":
            for line in src_lines[i1:i2]:
                result.append({"line": line, "type": "remove"})
            for line in dest_lines[j1:j2]:
                result.append({"line": line, "type": "add"})
    return result

def _aligned_diff(left_text, right_text):
    """Return aligned pairs [{left, right, type}] for side-by-side diff tab view."""
    left_lines = (left_text or "").splitlines()
    right_lines = (right_text or "").splitlines()
    result = []
    matcher = difflib.SequenceMatcher(None, left_lines, right_lines, autojunk=False)
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            for line in left_lines[i1:i2]:
                result.append({"left": line, "right": line, "type": "context"})
        elif op == "insert":
            for line in right_lines[j1:j2]:
                result.append({"left": "", "right": line, "type": "right_only"})
        elif op == "delete":
            for line in left_lines[i1:i2]:
                result.append({"left": line, "right": "", "type": "left_only"})
        elif op == "replace":
            l_lines = left_lines[i1:i2]
            r_lines = right_lines[j1:j2]
            max_len = max(len(l_lines), len(r_lines))
            for k in range(max_len):
                l = l_lines[k] if k < len(l_lines) else ""
                r = r_lines[k] if k < len(r_lines) else ""
                if l and r:
                    result.append({"left": l, "right": r, "type": "changed"})
                elif l:
                    result.append({"left": l, "right": "", "type": "left_only"})
                else:
                    result.append({"left": "", "right": r, "type": "right_only"})
    return result

def instance_diff(src_client, dest_client) -> dict:
    """Compare all APIs between two APIM instances.

    Matches first by slug id, then falls back to displayName for unmatched
    entries — same human label across envs with different slugs is reported
    as 'renamed' rather than two separate 'only in src/dest' rows.
    """
    src_apis = _deduplicate_apis(src_client.list_all("apis"))
    dest_apis = _deduplicate_apis(dest_client.list_all("apis"))

    only_in_src = []
    only_in_dest = []
    different = []
    identical = []
    renamed = []

    matched_src_ids = set()
    matched_dest_ids = set()

    # Pass 1: same-slug matches
    for name in sorted(set(src_apis) & set(dest_apis)):
        s = src_apis[name].get("properties", {})
        d = dest_apis[name].get("properties", {})
        matched_src_ids.add(name)
        matched_dest_ids.add(name)
        if s.get("apiRevision", "1") != d.get("apiRevision", "1") or s.get("path", "") != d.get("path", ""):
            different.append({
                "id": name,
                "displayName": s.get("displayName", ""),
                "src_revision": s.get("apiRevision", "1"),
                "dest_revision": d.get("apiRevision", "1"),
                "src_path": s.get("path", ""),
                "dest_path": d.get("path", ""),
            })
        else:
            identical.append({
                "id": name,
                "displayName": s.get("displayName", ""),
                "path": s.get("path", ""),
                "revision": s.get("apiRevision", "1"),
            })

    # Pass 2: displayName matches for the rest. Skip ambiguous cases where
    # a label appears more than once in either side (rare but possible).
    def _index_by_display_name(apis, exclude_ids):
        idx = {}
        for slug, api in apis.items():
            if slug in exclude_ids:
                continue
            dn = (api.get("properties", {}).get("displayName") or "").strip().lower()
            if not dn:
                continue
            idx.setdefault(dn, []).append(slug)
        return idx

    src_by_name = _index_by_display_name(src_apis, matched_src_ids)
    dest_by_name = _index_by_display_name(dest_apis, matched_dest_ids)
    for dn, src_slugs in src_by_name.items():
        dest_slugs = dest_by_name.get(dn, [])
        if len(src_slugs) != 1 or len(dest_slugs) != 1:
            continue
        src_slug, dest_slug = src_slugs[0], dest_slugs[0]
        s = src_apis[src_slug].get("properties", {})
        d = dest_apis[dest_slug].get("properties", {})
        renamed.append({
            "displayName": s.get("displayName", ""),
            "src_id": src_slug,
            "dest_id": dest_slug,
            "src_path": s.get("path", ""),
            "dest_path": d.get("path", ""),
            "src_revision": s.get("apiRevision", "1"),
            "dest_revision": d.get("apiRevision", "1"),
        })
        matched_src_ids.add(src_slug)
        matched_dest_ids.add(dest_slug)

    # Remaining: truly only-in-src / only-in-dest
    for name in sorted(set(src_apis) - matched_src_ids):
        props = src_apis[name].get("properties", {})
        only_in_src.append({
            "id": name,
            "displayName": props.get("displayName", ""),
            "path": props.get("path", ""),
            "revision": props.get("apiRevision", "1"),
        })
    for name in sorted(set(dest_apis) - matched_dest_ids):
        props = dest_apis[name].get("properties", {})
        only_in_dest.append({
            "id": name,
            "displayName": props.get("displayName", ""),
            "path": props.get("path", ""),
            "revision": props.get("apiRevision", "1"),
        })

    return {
        "only_in_src": only_in_src,
        "only_in_dest": only_in_dest,
        "different": different,
        "identical": identical,
        "renamed": renamed,
        "summary": {
            "total_src": len(src_apis),
            "total_dest": len(dest_apis),
            "only_src": len(only_in_src),
            "only_dest": len(only_in_dest),
            "different": len(different),
            "identical": len(identical),
            "renamed": len(renamed),
        },
    }


def api_diff(src_client, dest_client, api_id: str, src_env: str = "source", dest_env: str = "dest") -> dict:
    """Detailed comparison of a single API across two instances."""
    src_status, src_data = src_client.get(f"apis/{api_id}")

    # Build src info
    if src_status == 200:
        sp = src_data.get("properties", {})
        src_info = {"displayName": sp.get("displayName", ""), "revision": sp.get("apiRevision", "1"), "path": sp.get("path", "")}
    else:
        src_info = None

    # Try to find matching API in dest — first by same id, then by display name or path
    dest_status, dest_data = dest_client.get(f"apis/{api_id}")
    dest_api_id = api_id  # default — same id

    if dest_status != 200 and src_info:
        # Fall back to matching by display name or path across all dest APIs
        # But ONLY if it's the same version (to avoid comparing different versions)
        try:
            src_version = src_data.get("properties", {}).get("apiVersion", "")
            dest_apis = dest_client.list_all("apis", extra_params="&$filter=isCurrent eq true&$top=500")
            src_display = src_info["displayName"].lower()
            src_path = src_info["path"].lower()
            for dapi in dest_apis:
                dp = dapi.get("properties", {})
                dest_version = dp.get("apiVersion", "")
                # Only match if display name/path AND version match (same version in both envs)
                if (dp.get("displayName", "").lower() == src_display or dp.get("path", "").lower() == src_path) and src_version == dest_version:
                    dest_api_id = dapi.get("name", api_id)
                    dest_status, dest_data = dest_client.get(f"apis/{dest_api_id}")
                    break
        except Exception:
            pass

    # Build dest info
    if dest_status == 200:
        dp = dest_data.get("properties", {})
        dest_info = {"displayName": dp.get("displayName", ""), "revision": dp.get("apiRevision", "1"), "path": dp.get("path", "")}
    else:
        dest_info = None

    def _op_summary(op):
        p = op.get("properties", {})
        return {"id": op.get("name", ""), "method": p.get("method", ""), "urlTemplate": p.get("urlTemplate", "")}

    # If source API doesn't exist — API only in dest
    if src_info is None:
        if dest_info is None:
            # Neither environment has the API
            return {
                "api_id": api_id,
                "src": None,
                "dest": None,
                "error": f"API {api_id} not found in {src_env} (source) or {dest_env} (dest)",
            }
        # API only exists in dest
        dest_ops_list = dest_client.list_all(f"apis/{dest_api_id}/operations")
        ops_dest_only = [_op_summary(op) for op in dest_ops_list if op.get("name")]

        dp_s, dp_xml = dest_client.get(f"apis/{dest_api_id}/policies/policy", rawxml=True)
        dest_api_policy = dp_xml if dp_s == 200 else None

        return {
            "api_id": api_id,
            "src": None,
            "dest": dest_info,
            "src_revision": "missing",
            "dest_revision": dest_info["revision"],
            "ops_added": 0,
            "ops_removed": len(ops_dest_only),
            "ops_changed": 0,
            "backends_count": 0,
            "src_policy": None,
            "dest_policy": dest_api_policy,
            "policy_diff": _unified_diff(dest_api_policy, None),
            "aligned_policy_diff": _aligned_diff(None, dest_api_policy),
            "operations": {"only_in_src": [], "only_in_dest": ops_dest_only, "common": []},
            "policy": {"src": None, "dest": dest_api_policy, "differs": True},
        }

    # Fetch source operations and policies (only if src API exists)
    src_ops_list = src_client.list_all(f"apis/{api_id}/operations")
    src_ops = {op.get("name", ""): op for op in src_ops_list if op.get("name")}

    # API-level policy
    sp_s, sp_xml = src_client.get(f"apis/{api_id}/policies/policy", rawxml=True)
    src_api_policy = sp_xml if sp_s == 200 else None

    # Operation-level policies from source
    src_op_policies = {}
    for op_id in src_ops:
        op_s, op_xml = src_client.get(f"apis/{api_id}/operations/{op_id}/policies/policy", rawxml=True)
        if op_s == 200 and op_xml:
            src_op_policies[op_id] = op_xml

    # Compute backends count from all source policies
    all_src_xml = (src_api_policy or "") + "".join(src_op_policies.values())
    backends_count = len(set(extract_backend_ids(all_src_xml)))

    # If dest is missing — all ops are "new", no dest policies to compare
    if dest_info is None:
        ops_src_only = [_op_summary(op) for op in src_ops_list if op.get("name")]

        # Build op policy diffs — all are "added"
        op_policy_diffs = {}
        for op_id, op_xml in src_op_policies.items():
            op_policy_diffs[op_id] = {
                "src": op_xml,
                "dest": None,
                "diff": _unified_diff(None, op_xml),
                "differs": True,
            }

        return {
            "api_id": api_id,
            "src": src_info,
            "dest": None,
            "src_revision": src_info["revision"] if src_info else "1",
            "dest_revision": "new",
            "ops_added": len(ops_src_only),
            "ops_changed": 0,
            "backends_count": backends_count,
            "src_policy": src_api_policy,
            "dest_policy": None,
            "policy_diff": _unified_diff(None, src_api_policy),
            "aligned_policy_diff": _aligned_diff(src_api_policy, None),
            "op_policy_diffs": op_policy_diffs,
            "operations": {"only_in_src": ops_src_only, "only_in_dest": [], "common": []},
            "policy": {"src": src_api_policy, "dest": None, "differs": True},
        }

    # Both exist — compare operations and policies
    try:
        dest_ops_list = dest_client.list_all(f"apis/{dest_api_id}/operations")
        dest_ops = {op.get("name", ""): op for op in dest_ops_list if op.get("name")}
    except Exception:
        dest_ops = {}

    src_op_names = set(src_ops.keys())
    dest_op_names = set(dest_ops.keys())

    ops_only_src = [_op_summary(src_ops[n]) for n in sorted(src_op_names - dest_op_names)]
    ops_only_dest = [_op_summary(dest_ops[n]) for n in sorted(dest_op_names - src_op_names)]
    ops_common = [_op_summary(src_ops[n]) for n in sorted(src_op_names & dest_op_names)]

    # Dest API-level policy — fetch using isCurrent revision
    dest_api_policy = None
    try:
        dp_s, dp_xml = dest_client.get(f"apis/{dest_api_id}/policies/policy", rawxml=True)
        if dp_s == 200 and dp_xml:
            dest_api_policy = dp_xml
        elif dp_s not in (404, 204):
            # Try fetching via the dest current revision explicitly
            dest_rev = dest_info.get("revision", "1") if dest_info else "1"
            if dest_rev and dest_rev != "1":
                rev_api_id = f"{dest_api_id};rev={dest_rev}"
                dp_s2, dp_xml2 = dest_client.get(f"apis/{rev_api_id}/policies/policy", rawxml=True)
                if dp_s2 == 200 and dp_xml2:
                    dest_api_policy = dp_xml2
    except Exception:
        dest_api_policy = None

    # Operation-level policies from dest
    dest_op_policies = {}
    for op_id in dest_ops:
        try:
            op_s, op_xml = dest_client.get(f"apis/{dest_api_id}/operations/{op_id}/policies/policy", rawxml=True)
            if op_s == 200 and op_xml:
                dest_op_policies[op_id] = op_xml
            elif op_s not in (404, 204):
                dest_rev = dest_info.get("revision", "1") if dest_info else "1"
                if dest_rev and dest_rev != "1":
                    rev_api_id = f"{dest_api_id};rev={dest_rev}"
                    op_s, op_xml = dest_client.get(f"apis/{rev_api_id}/operations/{op_id}/policies/policy", rawxml=True)
                    if op_s == 200 and op_xml:
                        dest_op_policies[op_id] = op_xml
        except Exception:
            pass

    # Build per-operation policy diffs
    all_op_ids = src_op_names | dest_op_names
    op_policy_diffs = {}
    for op_id in sorted(all_op_ids):
        src_xml = src_op_policies.get(op_id)
        dest_xml = dest_op_policies.get(op_id)
        if src_xml or dest_xml:
            op_policy_diffs[op_id] = {
                "src": src_xml,
                "dest": dest_xml,
                "diff": _unified_diff(dest_xml, src_xml),
                "aligned_diff": _aligned_diff(src_xml, dest_xml),
                "differs": src_xml != dest_xml,
            }

    return {
        "api_id": api_id,
        "src": src_info,
        "dest": dest_info,
        "src_revision": src_info["revision"],
        "dest_revision": dest_info["revision"],
        "ops_added": len(ops_only_src),
        "ops_changed": len(ops_only_dest),
        "backends_count": backends_count,
        "src_policy": src_api_policy,
        "dest_policy": dest_api_policy,
        "policy_diff": _unified_diff(dest_api_policy, src_api_policy),
        "aligned_policy_diff": _aligned_diff(src_api_policy, dest_api_policy),
        "op_policy_diffs": op_policy_diffs,
        "operations": {
            "only_in_src": ops_only_src,
            "only_in_dest": ops_only_dest,
            "common": ops_common,
        },
        "policy": {
            "src": src_api_policy,
            "dest": dest_api_policy,
            "differs": src_api_policy != dest_api_policy,
        },
    }
