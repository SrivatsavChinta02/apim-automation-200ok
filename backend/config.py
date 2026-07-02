import os
from dotenv import load_dotenv

# override=True so .env wins over any pre-existing shell env vars (e.g. an
# empty ANTHROPIC_API_KEY left in the user's PowerShell session). The .env
# file is the source of truth for this project's config.
load_dotenv(override=True)

# Tenant is shared across all envs
_TENANT_ID = os.environ.get("AZURE_TENANT_ID", "")

APIM_INSTANCES = {
    "dev": {
        "name": "azsidevapim",
        "subscription_id": "5d8489a3-e9e7-464d-bf8b-9a0ba7f4a71f",
        "resource_group": "AzResourceGpNPAPIM",
        "tenant_id": _TENANT_ID,
        "client_id": os.environ.get("DEV_CLIENT_ID", ""),
        "client_secret": os.environ.get("DEV_CLIENT_SECRET", ""),
    },
    "sandbox": {
        "name": "azsiapimnp1cassist",
        "subscription_id": "8f1b4de7-0c41-4f8e-b822-72e4f157037c",
        "resource_group": "AzResourceGpBot",
        "tenant_id": _TENANT_ID,
        "client_id": os.environ.get("SANDBOX_CLIENT_ID", ""),
        "client_secret": os.environ.get("SANDBOX_CLIENT_SECRET", ""),
    },
    "prod": {
        "name": "azsipdapim",
        "subscription_id": os.environ.get("PROD_SUBSCRIPTION_ID", ""),
        "resource_group": os.environ.get("PROD_RESOURCE_GROUP", "AzResourceGpPDAPIM"),
        "tenant_id": _TENANT_ID,
        "client_id": os.environ.get("PROD_CLIENT_ID", ""),
        "client_secret": os.environ.get("PROD_CLIENT_SECRET", ""),
    },
    "dr": {
        "name": "azcidrapim",
        "subscription_id": os.environ.get("DR_SUBSCRIPTION_ID", ""),
        "resource_group": os.environ.get("DR_RESOURCE_GROUP", "AzResourceGpDRAPIM"),
        "tenant_id": _TENANT_ID,
        "client_id": os.environ.get("DR_CLIENT_ID", ""),
        "client_secret": os.environ.get("DR_CLIENT_SECRET", ""),
    },
}

API_VER = "2022-08-01"
BACKEND_API_VER = "2024-05-01"
POLICY_VER = "2022-08-01"

FLASK_PORT = int(os.environ.get("FLASK_PORT", "5050"))
ALLOWED_EXTENSION_ID = os.environ.get("ALLOWED_EXTENSION_ID", "")
DEFAULT_ENV = os.environ.get("DEFAULT_ENV", "dev")

# Comma-separated list of extra origins allowed to call the API (e.g. the
# Next.js web UI). Defaults to the Next.js dev server.
ALLOWED_WEB_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_WEB_ORIGINS", "http://localhost:3000").split(",") if o.strip()
]

# Used by api_creator.py for JWT policy
AZURE_TENANT_ID = _TENANT_ID

BUILTIN_APIS = {"echo-api"}
BUILTIN_PRODUCTS = {"starter", "unlimited"}

ENV_LABELS = {"dev": "Dev", "sandbox": "Sandbox", "prod": "Prod", "dr": "DR"}