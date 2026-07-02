"""Helper for uploading certificates to APIM with thumbprint-based reuse.

Lookup-by-thumbprint first; if the same cert already exists in this env,
return its existing id without re-uploading. Otherwise upload as new with
collision-suffix on the id.
"""
import base64
from utils.logger import get_logger

log = get_logger(__name__)


def _extract_thumbprint_from_pfx(pfx_bytes: bytes, password: str):
    """Best-effort thumbprint extraction. Returns None on any error."""
    try:
        from cryptography.hazmat.primitives.serialization import pkcs12
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.backends import default_backend
        _, cert, _ = pkcs12.load_key_and_certificates(
            pfx_bytes, password.encode() if password else None, default_backend()
        )
        if cert is None:
            return None
        return cert.fingerprint(hashes.SHA1()).hex().upper()
    except Exception as e:
        log.warning("thumbprint_extract_failed", extra={"error": str(e)})
        return None


def _normalise_thumbprint(t: str) -> str:
    return (t or "").upper().replace(":", "").strip()


def _find_by_thumbprint(client, endpoint: str, thumbprint: str):
    """Return the existing item dict if thumbprint matches, else None."""
    if not thumbprint:
        return None
    items = client.list_all(endpoint)
    target = _normalise_thumbprint(thumbprint)
    for it in items:
        existing = _normalise_thumbprint(it.get("properties", {}).get("thumbprint") or "")
        if existing == target:
            return it
    return None


def _unique_cert_id(client, endpoint: str, suggested: str) -> str:
    """If suggested id exists (by GET), append -2, -3 until free."""
    candidate = suggested
    counter = 1
    while True:
        status, _ = client.get(f"{endpoint}/{candidate}")
        if status == 404:
            return candidate
        counter += 1
        candidate = f"{suggested}-{counter}"
        if counter > 99:
            raise RuntimeError(f"cert id collision: tried 99 suffixes of {suggested}")


def upload_or_reuse_certificate(client, pfx_bytes: bytes, password: str,
                                 suggested_id: str, thumbprint_override: str = None):
    """Upload a client cert to APIM /certificates with thumbprint-based reuse.

    Returns: {"cert_id": str, "thumbprint": str, "reused": bool}
    """
    thumbprint = thumbprint_override or _extract_thumbprint_from_pfx(pfx_bytes, password)
    if thumbprint:
        existing = _find_by_thumbprint(client, "certificates", thumbprint)
        if existing:
            return {
                "cert_id": existing.get("name", ""),
                "thumbprint": existing.get("properties", {}).get("thumbprint", ""),
                "reused": True,
            }
    cert_id = _unique_cert_id(client, "certificates", suggested_id)
    body = {
        "properties": {
            "data": base64.b64encode(pfx_bytes).decode("ascii"),
            "password": password or "",
        }
    }
    status, data = client.put(f"certificates/{cert_id}", body)
    if not (200 <= status < 300):
        raise RuntimeError(f"cert upload failed: status={status} body={data}")
    return {
        "cert_id": cert_id,
        "thumbprint": (data.get("properties", {}).get("thumbprint") or thumbprint or ""),
        "reused": False,
    }


def upload_or_reuse_ca_certificate(client, pfx_bytes: bytes, password: str,
                                    suggested_id: str, store_name: str,
                                    thumbprint_override: str = None):
    """Upload a CA cert to APIM /caCertificates."""
    if store_name not in ("Root", "CertificateAuthority"):
        raise ValueError("store_name must be 'Root' or 'CertificateAuthority'")
    thumbprint = thumbprint_override or _extract_thumbprint_from_pfx(pfx_bytes, password)
    if thumbprint:
        existing = _find_by_thumbprint(client, "caCertificates", thumbprint)
        if existing:
            return {
                "ca_id": existing.get("name", ""),
                "thumbprint": existing.get("properties", {}).get("thumbprint", ""),
                "reused": True,
            }
    ca_id = _unique_cert_id(client, "caCertificates", suggested_id)
    body = {
        "properties": {
            "data": base64.b64encode(pfx_bytes).decode("ascii"),
            "password": password or "",
            "storeName": store_name,
        }
    }
    status, data = client.put(f"caCertificates/{ca_id}", body)
    if not (200 <= status < 300):
        raise RuntimeError(f"CA cert upload failed: status={status} body={data}")
    return {
        "ca_id": ca_id,
        "thumbprint": (data.get("properties", {}).get("thumbprint") or thumbprint or ""),
        "reused": False,
    }
