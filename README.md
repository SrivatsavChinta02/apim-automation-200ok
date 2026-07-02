# APIM Automation Extension

Chrome extension + Flask backend for automating Azure API Management tasks (onboarding APIs, promoting between environments, policy diffing, spec import, AI assistant).

## Structure

- [`backend/`](backend/) — Flask API that talks to Azure APIM (auth, promotion rules, policy building, spec import, NLP assistant).
- [`extension/`](extension/) — Chrome side-panel extension (MV3) that drives the backend.
- [`web/`](web/) — Next.js chat UI that drives the backend's `/api/assistant/*` endpoints (hackathon front-end).

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

## Web (chat) UI setup

```bash
cd web
npm install
npm run dev   # http://localhost:3000
```

Talks to the Flask backend at `NEXT_PUBLIC_BACKEND_URL` (`web/.env.local`, defaults to `http://localhost:5050`). The backend must be running and must allow the web app's origin — `ALLOWED_WEB_ORIGINS` in `backend/.env` (defaults to `http://localhost:3000`).

Chat flow: sends free-text queries to `/api/assistant/parse`; executes the returned plan's steps (with a confirm step for gated/destructive actions), or falls back to the agentic `/api/assistant/analyze` SSE loop for analytical questions.

## Known follow-ups

- `backend/app.py` is a ~1,600-line monolith with all routes defined inside `create_app()`. Worth splitting into Flask blueprints per feature (onboard, promote, diff, assistant, etc.) once there's test coverage to verify against.
- `pytest`/`requests-mock` are already in `requirements.txt` but there's no `tests/` directory yet.
- The web chat UI doesn't yet handle the `analyze` loop's version-selection gate (`/api/assistant/analyze/select-version`) — only tool-confirmation gates. Rare in practice (ambiguous API version during `add_operations`), but worth adding if it comes up during the demo.
