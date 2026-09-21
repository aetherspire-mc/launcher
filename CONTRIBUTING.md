# Contributing to Aetherspire Launcher

Thanks for taking a look. This is a small Electron app with no framework beyond Electron
itself, and contributions of any size (a typo fix, a bug report, a new feature) are
welcome.

## Dev setup

```bash
git clone https://github.com/<you>/launcher.git aetherspire-launcher
cd aetherspire-launcher
npm ci
npm start
```

By default `npm start` talks to a local server at `http://127.0.0.1:8080/api/v1`. If you
don't have an Aetherspire server running, most of the UI will simply show no data; the
login screen and general layout still work. See the README's "Configuration" section for
the environment variables that point the launcher elsewhere.

## Running checks and tests

Before opening a pull request, run both of these and make sure they pass:

```bash
npm run check   # node --check on every source file (syntax only)
npm test        # the project's test scripts
```

Tests live next to the code they cover, as `*.test.js` files (for example
`src/api.test.js`, `renderer/seatshape.test.js`). If you add a new source file that has
meaningful logic, add a matching `*.test.js` file and wire it into the `test` script in
`package.json`.

CI runs the same two commands on Linux and Windows for every pull request.

## Code style

There's no linter configured, so please follow what's already there:

- Plain JavaScript, no build step, no framework. `'use strict';` at the top of each file.
- CommonJS (`require`/`module.exports`), matching the rest of the codebase.
- Comment the *why*, not the *what*. Several files (`src/game/java.js`, `src/game/pack.js`)
  have a short doc comment at the top explaining the problem the file solves; keep that
  pattern for anything non-obvious.
- 2-space indentation, single quotes for strings, semicolons. Match the surrounding file if
  in doubt, and check `.editorconfig` for whitespace and line-ending settings.

## Branch and PR flow

1. Fork the repository.
2. Create a branch off `main` for your change (`git checkout -b fix/thing-that-was-broken`).
3. Make your change, with tests where it makes sense.
4. Run `npm run check` and `npm test` locally.
5. Open a pull request against `main`. Describe what changed and why, and link any related
   issue.

## Commit messages

Keep commit messages short and specific about what changed, in the imperative mood
("fix pack hash check", not "fixed" or "fixes"). A `type: summary` prefix (`fix:`, `feat:`,
`docs:`, `test:`, `chore:`) is welcome but not required, if it makes the history easier to
scan.

## Opening a good issue

For bugs, include: what you did, what you expected, what happened instead, your OS, and
the launcher version. Logs from the launcher window's DevTools (Ctrl/Cmd+Shift+I) are
often the fastest way to spot the problem.

For feature requests, describe the problem you're trying to solve, not just the feature;
it makes it easier to see if there's a simpler fix.

## What gets merged

We merge pull requests that fit the launcher and work: CI is green, you have run the
launcher with your change, and the change does one thing the PR description explains.
Merged changes ship to players in the next launcher release, and you are credited in the
commit history.

If you are unsure whether an idea fits, open an issue first and ask. A short "would you
take a PR for X?" saves everyone time.

## Response times

This is maintained by a small team alongside running the Aetherspire server itself, so a
review can take a few days. If a PR has been quiet for a week, a friendly ping is welcome.
