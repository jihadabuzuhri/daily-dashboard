<!--
Thanks for contributing! Please fill in the sections below.
See CONTRIBUTING.md for setup instructions and the full manual-verification checklist.
-->

## What changed

<!-- A short summary of the change. -->

## Why

<!-- The problem this solves, or the issue it closes. e.g. "Closes #42" -->

## How this was tested

<!--
There are no automated tests in this project, so describe your manual verification:
which browser, which storage tier (dev file store / gist / localStorage), and what you exercised.
-->

- Browser / OS:
- Storage tier exercised:
- Steps performed:

## Screenshots

<!--
Required for any UI change — before/after images or a short clip.
Delete this section if the change has no visual effect.
-->

## Checklist

- [ ] `npm run dev` starts with no new console errors
- [ ] `npm run build` succeeds
- [ ] Tasks, links, and theme still add / edit / reorder / delete / persist correctly across a reload
- [ ] Before/after screenshots included, or the change has no UI impact
- [ ] No unrelated functionality or files were changed, and no unrelated formatting churn is included
- [ ] The change stays compatible with the existing architecture (vanilla JS, no new runtime dependencies, no framework) — see [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md#architecture-guidelines)
- [ ] Any new persisted field was added to `DEFAULTS` and the PUT whitelist in `vite.config.js` **and** to `store.state` in `src/main.js`
- [ ] Documentation (README / CLAUDE.md) updated if behavior or setup changed
