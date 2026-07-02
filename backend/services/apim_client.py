import json
import requests
from config import APIM_INSTANCES

MGMT = "https://management.azure.com"
DEFAULT_API_VERSION = "2022-08-01"


class ApimClient:
    def __init__(self, environment: str, auth_service):
        cfg = APIM_INSTANCES[environment]
        self.sub = cfg["subscription_id"]
        self.rg = cfg["resource_group"]
        self.apim = cfg["name"]
        self.auth_service = auth_service
        self.base_url = (
            f"{MGMT}/subscriptions/{self.sub}/resourceGroups/{self.rg}"
            f"/providers/Microsoft.ApiManagement/service/{self.apim}"
        )

    def _headers(self, extra: dict = None) -> dict:
        token = self.auth_service.get_token("https://management.azure.com/.default")
        h = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def _url(self, path: str, ver: str = None, extra_params: str = "") -> str:
        v = ver or DEFAULT_API_VERSION
        return f"{self.base_url}/{path}?api-version={v}{extra_params}"

    def get(self, path: str, ver: str = None, rawxml: bool = False, extra_params: str = "") -> tuple:
        extra = ("&format=rawxml" if rawxml else "") + extra_params
        r = requests.get(self._url(path, ver, extra), headers=self._headers())
        body = r.text.lstrip("\ufeff")
        if rawxml:
            return r.status_code, body
        try:
            return r.status_code, json.loads(body) if body else {}
        except json.JSONDecodeError:
            return r.status_code, {"raw": body}

    def put(self, path: str, body: dict, ver: str = None, extra_params: str = "") -> tuple:
        r = requests.put(
            self._url(path, ver, extra_params),
            headers=self._headers({"If-Match": "*"}),
            json=body if body else None,
        )
        raw = r.text.lstrip("\ufeff")
        try:
            return r.status_code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return r.status_code, {"raw": raw}

    def post(self, path: str, body: dict = None, ver: str = None) -> tuple:
        r = requests.post(
            self._url(path, ver),
            headers=self._headers(),
            json=body,
        )
        raw = r.text.lstrip("\ufeff")
        try:
            return r.status_code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return r.status_code, {"raw": raw}

    def patch(self, path: str, body: dict, ver: str = None) -> tuple:
        r = requests.patch(
            self._url(path, ver),
            headers=self._headers({"If-Match": "*"}),
            json=body if body else None,
        )
        raw = r.text.lstrip("\ufeff")
        try:
            return r.status_code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return r.status_code, {"raw": raw}

    def delete(self, path: str, ver: str = None, extra_params: str = "") -> tuple:
        r = requests.delete(
            self._url(path, ver, extra_params),
            headers=self._headers({"If-Match": "*"}),
        )
        raw = r.text.lstrip("\ufeff")
        try:
            return r.status_code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return r.status_code, {"raw": raw}

    def list_all(self, path: str, ver: str = None, extra_params: str = "") -> list:
        results = []
        url = self._url(path, ver, extra_params)
        while url:
            r = requests.get(url, headers=self._headers())
            if r.status_code not in (200, 206):
                raise RuntimeError(f"list_all failed at {url}: HTTP {r.status_code} — {r.text[:200]}")
            try:
                data = json.loads(r.text.lstrip("\ufeff"))
            except json.JSONDecodeError:
                raise RuntimeError(f"list_all: non-JSON response from APIM: {r.text[:200]}")
            results.extend(data.get("value", []))
            url = data.get("nextLink")
        return results
