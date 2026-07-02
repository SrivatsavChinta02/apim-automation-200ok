import time
import threading
from msal import ConfidentialClientApplication


class AuthService:
    def __init__(self, tenant_id: str, client_id: str, client_secret: str):
        authority = f"https://login.microsoftonline.com/{tenant_id}"
        self._app = ConfidentialClientApplication(
            client_id,
            authority=authority,
            client_credential=client_secret,
        )
        # Per-scope token cache: scope -> (token, expires_at)
        self._token_cache: dict = {}
        # One lock per scope so concurrent requests for DIFFERENT scopes don't block each other
        self._scope_locks: dict = {}
        self._scope_locks_lock = threading.Lock()

    def _get_scope_lock(self, scope: str) -> threading.Lock:
        with self._scope_locks_lock:
            if scope not in self._scope_locks:
                self._scope_locks[scope] = threading.Lock()
            return self._scope_locks[scope]

    def get_token(self, scope: str) -> str:
        # Fast path: return cached token if still valid (with 60s buffer)
        cached = self._token_cache.get(scope)
        if cached and time.time() < cached[1]:
            return cached[0]

        # Slow path: acquire lock per scope and fetch/refresh token
        lock = self._get_scope_lock(scope)
        with lock:
            # Double-check after acquiring lock — another thread may have refreshed it
            cached = self._token_cache.get(scope)
            if cached and time.time() < cached[1]:
                return cached[0]

            # Try silent first (uses MSAL's internal cache), then acquire fresh
            result = self._app.acquire_token_silent([scope], account=None)
            if not result:
                result = self._app.acquire_token_for_client(scopes=[scope])

            if "access_token" not in result:
                raise RuntimeError(
                    f"Token acquisition failed: {result.get('error')} — {result.get('error_description')}"
                )

            token = result["access_token"]
            # Cache for (expires_in - 60) seconds; default 3540s if not provided
            expires_in = result.get("expires_in", 3600)
            self._token_cache[scope] = (token, time.time() + expires_in - 60)
            return token
