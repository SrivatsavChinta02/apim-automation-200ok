# APIM Automation Extension

Chrome extension + Flask backend for automating Azure API Management tasks (onboarding APIs, promoting between environments, policy diffing, spec import, AI assistant).

## Structure

- [`backend/`](backend/) — Flask API that talks to Azure APIM (auth, promotion rules, policy building, spec import).
- [`extension/`](extension/) — Chrome side-panel extension (MV3) that drives the backend.

## Backend setup

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env   # fill in tenant/client IDs, secrets, admin creds, Anthropic key
python app.py
```

`.env` holds live secrets (Azure client secrets, admin password, Anthropic API key) and is gitignored — never commit it.

## Extension setup

Load `extension/` as an unpacked extension via `chrome://extensions` (Developer mode).

## Known follow-ups

- `backend/app.py` is a ~1,600-line monolith with all routes defined inside `create_app()`. Worth splitting into Flask blueprints per feature (onboard, promote, diff, assistant, etc.) once there's test coverage to verify against.
- `pytest`/`requests-mock` are already in `requirements.txt` but there's no `tests/` directory yet.
