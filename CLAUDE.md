# AntiGravity Portfolio — Claude Code Guidelines

## PR Workflow

**Branch-first for PRs.** When working on a feature or fix, create a feature branch before committing:

```bash
git checkout -b feature-name
# Make changes, commit
git push -u origin feature-name
```

Once pushed, `gh pr create` will open a PR against `main` automatically. This allows:
- Clean PR history with focused commits
- Automated PR creation via `gh pr create`
- Code review before merging to the live `main` branch

**Direct commits to `main`** (e.g., urgent hotfixes) are acceptable but should be reserved for critical production issues only.

## Tech Stack & Key Files

- **Frontend:** HTML5 + vanilla JS, Chart.js for visualizations
- **Data:** PWA with Service Worker caching (v57+)
- **Main entry:** `index.html`, `app.js` (business logic), `js/api.js` (price fetching)
- **Styling:** `style.css` with CSS custom properties (theme variables)
- **Build:** None — static files served directly from GitHub Pages
- **Deployment:** `main` branch → GitHub Pages (gh-pages)

## Known Patterns

- **Data sources:** Stocks from Yahoo Finance, MFs from Kuvera, benchmarks (Nifty 50) from Yahoo `^NSEI`
- **Price refresh:** Auto-runs every 5min during market hours; manual via "Update Prices" button
- **Mobile layout:** Columns hidden on `≤768px` to prevent nested horizontal-scroll conflict
- **localStorage keys:** See `/Users/anchal/.claude/projects/.../memory/project_code_patterns.md`

## Conventions

- No comments unless the *why* is non-obvious (hidden constraint, workaround for a specific bug)
- Commit messages: imperative, one line + blank line + body with context
- Service Worker version bumps on any observable change (HTML/CSS/JS)
- Values in breakupSummary are in lakhs; format with `formatLakhs()` not `formatINR()`
