import re


def to_slug(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9-]", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s


def to_base_path(name: str) -> str:
    return "/" + to_slug(name)


def to_operation_id(verb: str, path: str) -> str:
    clean = re.sub(r"[{}]", "", path)
    slug = to_slug(clean.lstrip("/"))
    return f"{verb.lower()}-{slug}"


def strip_common_prefix(paths: list[str]) -> list[str]:
    if not paths or len(paths) == 1:
        return paths
    parts_list = [p.strip("/").split("/") for p in paths]
    min_len = min(len(p) for p in parts_list)
    common = 0
    for i in range(min_len):
        segment = parts_list[0][i]
        if segment.startswith("{"):
            break
        if all(p[i] == segment for p in parts_list):
            common = i + 1
        else:
            break
    if common == 0:
        return paths
    return ["/" + "/".join(p[common:]) for p in parts_list]
