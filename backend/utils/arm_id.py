import re
import copy
from config import APIM_INSTANCES

ARM_PATTERN = re.compile(
    r"/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.ApiManagement/service/[^/]+"
)


def remap_pool_backend(pool_json: dict, src_env: str, dest_env: str) -> dict:
    dest = APIM_INSTANCES[dest_env]
    dest_prefix = (
        f"/subscriptions/{dest['subscription_id']}"
        f"/resourceGroups/{dest['resource_group']}"
        f"/providers/Microsoft.ApiManagement/service/{dest['name']}"
    )
    result = copy.deepcopy(pool_json)
    for svc in result.get("properties", {}).get("pool", {}).get("services", []):
        svc["id"] = ARM_PATTERN.sub(dest_prefix, svc["id"])
    return result
