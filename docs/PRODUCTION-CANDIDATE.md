# Production-equivalent Mac candidate without publication

The dedicated `production-candidate.yml` workflow validates its exact branch and
commit, then builds both Mac architectures with existing distribution inputs.
It never creates a Release, tag, or update-feed write. Artifacts stay in GitHub
Actions until the owner-Mac gates and a separate publication review finish.

## Configuration and credential boundary

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are the established public login inputs.
  The candidate check accepts a publishable key or a legacy JWT with role `anon`;
  it refuses `service_role`, secret/unknown keys and unexpected runtime keys.
  Supabase authorization still depends on server-side grants/RLS and the user's
  authenticated identity. No live login or database request occurs in this check.
- `OPENGROUND_REALTIME` and `OPENGROUND_COLLAB_WS_URL` retain the existing release
  Variables, with no enabling fallback. The established Worker destination is
  pinned. An absent opt-in stays off; this work does not change the cloud policy.
- `OPENGROUND_PHONE_RELAY_APP_KEY` reuses the existing distribution install pass.
  Despite storage in Actions Secrets and Worker `ROOM_CREATE_KEY`, it is already
  deliberately present in every release app and is extractable by its recipient.
  It gates creation of new rooms, not entry to another pairing: the phone/Mac
  keys and sealed payload keys remain separate and are never bundled. See
  `PHONE_LINK.md`, Security model, and `worker/src/phoneRelayAuth.ts`.
  This candidate does not introduce a new credential, expand its capability or
  change any relay setting. The pass is never printed in logs or the manifest.
- Signing/notarization credentials exist only on the packaging step. Dependency
  installation and tests do not receive product-service or signing credentials.
  No `GH_TOKEN` is passed to electron-builder; the workflow has `contents: read`.

## Build and verification

`production-candidate-config.cjs` reuses the strict candidate signing policy and
retains only the established GitHub updater metadata. All runtime configuration,
Info.plist and embedded updater changes happen before final Developer ID signing.
The CLI explicitly uses `--publish never`; metadata presence is not permission
to publish. Do not run the ordinary `release.yml` for this step: even its
`publish=false` path writes a draft Release and uploads assets.

After signing, Apple notarization and stapling, the workflow verifies both apps'
strict signatures, architecture, version, actual runtime configuration and
embedded update destination without executing the apps. It checks the generated
Mac feed's sizes and SHA-512 against all four actual installers. Only installers,
four blockmaps, the local Mac feed and a SHA/run-specific manifest are retained.
No Windows update metadata is generated or changed by this Mac-only workflow.

The new artifact needs its own download/hash/normal macOS assessment and staged
owner-Mac test. The offline 0.11.181 smoke is not production login, phone pairing
or update acceptance. Do not migrate the real profile or restart automation as
part of this build. Original alert attribution remains unresolved: a new valid
signature or notarization is not proof that the earlier alert was a false positive.

## Checks

Run the production candidate, runtime config, signing and relay-auth regressions,
lint, both TypeScript configurations and screen checks. CI also runs the full
unit and browser suites plus local Worker relay/collaboration tests before it
uses existing signing/notarization assets. Never rerun an uncertain Apple
submission before checking the same run's state.
