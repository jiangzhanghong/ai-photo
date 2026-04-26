# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Start the server (node backend/server.js)
npm run dev      # Same as start
```

Server runs on port 8000 by default. No build step — static files are served directly.

No automated test suite exists; testing is manual via browser or curl.

## Environment Variables

Required for full functionality:
- `mysql_host`, `mysql_user`, `mysql_password`, `mysql_database` — MySQL connection
- `jwt_secret` — JWT signing key
- `admin_token` — Bearer token for all `/api/admin/*` endpoints

Optional:
- `PORT` — defaults to 8000
- `redis_addr`, `redis_password` — distributed refresh token store; falls back to in-memory Map
- `model_secret_key` — AES-256-GCM key for encrypting model credentials at rest

## Architecture

This is a single-process Node.js app with no framework — `backend/server.js` manually routes all requests using `req.url` and `req.method` comparisons.

**Request flow:** HTTP request → static file check → API route dispatch → MySQL query → JSON response

**Auth flow:** Phone verification code → auto-register/login → JWT access token (short-lived) + refresh token (stored in Redis or in-memory Map) → `Authorization: Bearer <token>` on protected routes. The current development code is `8888`; SMS gateway integration is still pending.

**Static file serving:** The server maps URL paths to the filesystem. `/` → `web/index.html`, `/member.html` → `web/member.html`, `/admin` → `admin/index.html`, everything else under `/` tries `web/<path>`.

**Frontend:** Pure HTML/CSS/JS with no build tooling. All JS is inline in the HTML files. `web/styles.css` covers both `index.html` and `member.html`.

**Admin auth:** All `/api/admin/*` routes require `X-Admin-Token: <admin_token>` (static token, not JWT).

**Model credentials:** Stored encrypted in MySQL using AES-256-GCM via `model_secret_key`. The `encrypt` / `decrypt` functions in `server.js` handle this.

**AI tasks:** Created via `/api/ai-image-tasks` and stored in MySQL with status tracking. The backend calls the configured Doubao Seedream model through an OpenAI-compatible image endpoint and records provider request IDs, result URLs, failures, and refunds.

## Code Conventions

From `AGENTS.md`:
- Semantic HTML with lowercase hyphenated class names
- Two-space indentation throughout
- Keep edits scoped — don't refactor surrounding code when fixing a specific issue
- Commit messages: imperative mood, present tense, under 72 characters
