-- Realtime collab — a member-visible SHARED NAME for a project.
--
-- og_projects.name holds the OPAQUE per-owner dedup hash (sha256(ownerId+path))
-- so the owner's local FS path never leaks to members. But a member who joins a
-- shared project still needs a HUMAN label to tell projects apart. `label` is
-- that: an owner-set display name, readable by every member.
--
-- No new policy needed: 0005 already lets the OWNER UPDATE og_projects ("og
-- projects owner update") and lets any member SELECT it ("og projects read"), so
-- the owner can set `label` and members can read it under the existing RLS.
-- `label` is nullable (unset until the owner names the project) and is NEVER the
-- path — only a label the owner deliberately chooses to share.

alter table public.og_projects add column if not exists label text;
