# Project Rules

## Image Generation Only

- For this project, create or edit images only with `/image gen` / the built-in `image_gen` tool.
- Do not manually create, compose, redraw, or edit image assets with HTML, CSS, SVG, canvas, Python/Pillow, ImageMagick, scripts, or other code-based graphics workflows.
- Do not use generated-code mockups as substitutes for image generation.
- If an image needs changes, write a better image-generation prompt and rerun `/image gen`.
- After generating an image, copying or resizing the generated file into the project is allowed only as file handling, not as manual visual editing.

## Architecture maintenance

- `ARCHITECTURE.md` is the single canonical architecture for the whole project. Read it before changing source, configuration, storage, integrations, permissions, or release workflows.
- Update its prose in the same change whenever behavior or structure changes. Describe implemented behavior separately from plans and dated external observations. Verify source first; old handoffs are historical evidence.
- Run `python3 scripts/architecture.py --refresh` to regenerate the factual source inventory. This does not certify the prose as accurate.
- After checking the prose against every changed source/configuration file, run `python3 scripts/architecture.py --reviewed`, then `python3 scripts/architecture.py --check` before finishing.
- Public CI runs `--check --scope public`; local full-workspace checks also cover proprietary Lite and private Insights. Never run a full refresh from a public-only checkout.
- Keep credentials, user transcripts, and private account details out of architecture/audit documents. Keep dated audit reports as evidence; do not label them permanently current.
