# BB Account Limits

A standalone BB quota dashboard. Runtime code uses the public `@get-bb/plugin-sdk` only. It displays quotas; it must not register executable agents or change model routing.

Read `docs/architecture.md` before changing source boundaries, pool grouping or pool summaries, and `weekly-pace.md` before changing pacing. `contract.ts` owns normalized DTOs and public RPC schemas. Preserve existing plugin, resource, cache and preference IDs when upgrading.

Sources own configuration, authentication, discovery and caching. Shared pool logic must remain independent of a service's credentials and API shape. An absent source is hidden; an explicitly configured but failing source retains an error or marked cached observation. Never invent missing quota, reset times or independent subscription counts.

Only fictional accounts and offline fixtures belong in tests, screenshots and examples. Do not commit credentials, host-local configuration or machine paths.

Verification: `npm ci`, `npm run check`, `npm run build`, `npm run package`. Build requires a BB CLI supporting the SDK version in `package.json`. Release archives include portable prebuilt bundles, source and icons; inspect the archive as well as source before publishing. Create a versioned Git tag and GitHub release only after independent review. Rebuild and package from the final committed source; attach the archive, SHA256SUMS and release-manifest.json. No npm publication is configured.

Delivery: after each implementation task passes required verification and applicable review, commit its scoped changes, push to `origin/main`, and verify the remote commit and required CI before reporting completion. This is standing authorization; do not ask for push confirmation again. Honor an explicit request to keep work local, and report any actual blocker. Keep host configuration and credentials outside Git.
