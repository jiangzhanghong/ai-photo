# Repository Guidelines

## Project Structure & Module Organization

This repository currently contains a static web landing page for `ai-photo`.

- `web/index.html` is the main page markup.
- `web/styles.css` contains all page styling.
- `web/assets/` stores image assets referenced by the page, such as hero, gallery, creator, avatar, and QR images.
- `README.md`, `web/README.md`, and `web/README.en.md` are project documentation files.
- `admin/`, `backend/`, and `weapp/` are present as empty placeholders for future modules. Do not add shared logic there until each module has a clear runtime and build setup.

## Build, Test, and Development Commands

There is no package manager or build tool configured yet. The web page can be viewed directly or served as static files:

```bash
open web/index.html
python3 -m http.server 8000 -d web
```

Use the local server when checking relative asset paths in a browser at `http://localhost:8000`.

## Coding Style & Naming Conventions

Keep HTML semantic and readable with two-space indentation, matching `web/index.html`. Use lowercase, hyphenated class names such as `site-header`, `hero-content`, and `price-card`. Keep CSS organized by page section, reuse existing custom properties in `:root`, and prefer explicit dimensions only when they match the current fixed-width design. Asset files should use lowercase kebab-case names, for example `work-landscape.jpg` or `creator-chen.jpg`.

## Testing Guidelines

No automated tests are configured. Before submitting changes, manually verify:

- `web/index.html` loads without console errors.
- All `web/assets/*` images referenced in HTML or CSS resolve correctly.
- Header links scroll to the expected section IDs.
- Layout remains visually intact at the intended fixed page width.

If automated tests are added later, document the command and place tests near the module they cover.

## Commit & Pull Request Guidelines

The current git history only uses `first commit`, so there is no detailed convention yet. Use short, imperative commit messages, for example `Update web gallery layout` or `Add backend scaffold`.

Pull requests should include a concise summary, affected paths, manual verification steps, and screenshots for visible web changes. Link related issues when available and call out any new dependencies, generated assets, or module setup changes.

## Agent-Specific Instructions

Keep edits scoped to the requested module. Do not introduce package tooling, frameworks, or generated files unless the task explicitly requires them.
