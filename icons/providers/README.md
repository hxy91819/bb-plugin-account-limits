# Provider artwork

These marks identify the service associated with a quota record. They are not
this plugin's branding and do not imply endorsement. Brand artwork remains the
property of its respective owner and is excluded from the plugin's MIT license.

| Service shown | Artwork and primary source |
| --- | --- |
| Claude | Unmodified [Claude site icon](https://claude.com/icon.png), as provided by [Claude](https://claude.com/). |
| Codex | The unmodified OpenAI developer-site icon from [OpenAI's official Codex documentation host](https://developers.openai.com/codex/). This is the OpenAI brand mark, not a claim of a separate Codex-specific logo. [OpenAI brand guidance](https://openai.com/brand/). |
| Antigravity | Full-color icon from [Google's Antigravity press assets](https://antigravity.google/press). |
| Gemini | Unmodified favicon from the [official Gemini site](https://gemini.google/overview/). |
| Cursor | `App Icons/PNG/APP_ICON_2D_DARK.png` from the archive linked by [Cursor's brand guidelines](https://cursor.com/brand). The supplied dark app tile is readable on both light and dark panels. |

Exact source URLs, archive entry and SHA-256 hashes are recorded in
[sources.json](sources.json). Files are stored byte-for-byte; they are not
redrawn, recolored or cropped. `provider-brand-assets.ts` embeds those same bytes
as data URLs so the rendered UI makes no external image requests and works
offline. Keep the embedded data and original files synchronized when updating.

Grok keeps its existing MIT-licensed vector geometry in `provider-icons.tsx`,
credited in `THIRD_PARTY_NOTICES.md`. It is not represented here as a newly
downloaded official asset. Unknown services retain a text fallback.
