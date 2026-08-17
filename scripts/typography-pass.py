"""Typography readability pass for the S6_cut UI.

Applies a systematic, auditable transformation to web/src/styles.css:
  1. Design tokens for a white-first text hierarchy.
  2. Global font-size bump (7-9px -> 11px, 10-11px -> 12px).
  3. Readability fixes for specific low-contrast rules.
"""

import re
import pathlib

p = pathlib.Path(__file__).resolve().parent.parent / "web" / "src" / "styles.css"
css = p.read_text(encoding="utf-8")
orig = css

# ---- 1. Design tokens ----
css = css.replace("--text: #f4f2f1;", "--text-primary: #ffffff;\n  --text: #ffffff;")
css = css.replace("--text-secondary: #b8b1ae;", "--text-secondary: #f2f2f2;")
css = css.replace("--text-muted: #7f7a7c;", "--text-muted: #d0d0d0;\n  --text-subtle: #b8b8b8;")
css = css.replace("--text-disabled: #555258;", "--text-disabled: #858585;")

# ---- 2. Placeholder + disabled opacity ----
css = css.replace(
    "input::placeholder, textarea::placeholder { color: #69646a; }",
    "input::placeholder, textarea::placeholder { color: #9c9ca5; opacity: 1; }",
)
css = css.replace(
    "button:disabled { cursor: not-allowed; opacity: .48; }",
    "button:disabled { cursor: not-allowed; opacity: .55; }",
)

# ---- 3. Global font-size bump (7-9 -> 11px, 10-11 -> 12px) ----
def bump(match: re.Match[str]) -> str:
    size = int(match.group(1))
    if size <= 9:
        return "font-size: 11px"
    if size <= 11:
        return "font-size: 12px"
    return match.group(0)


css = re.sub(r"font-size:\s*(\d+)px", bump, css)

# ---- 4. Readability pass on specific low-contrast / small text rules ----
readability = [
    # Eyebrow: compact but clearer
    (
        ".eyebrow { color: var(--copper-light); font-size: 12px; font-weight: 750; letter-spacing: .15em; text-transform: uppercase; margin-bottom: 8px; }",
        ".eyebrow { color: #e6b7a0; font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 8px; }",
    ),
    # Style cards (the 'Funny / Punchlines & reactions' example)
    (
        ".style-card strong { font-size: 12px; }",
        ".style-card strong { font-size: 12px; font-weight: 640; color: var(--text); }",
    ),
    (
        ".style-card small { grid-column: 2; color: var(--text-muted); font-size: 11px; }",
        ".style-card small { grid-column: 2; color: var(--text-subtle); font-size: 12px; font-weight: 450; line-height: 1.4; }",
    ),
    # Engine summary capability list
    (
        ".engine-summary ul { list-style: none; padding: 0; margin: 10px 0 0; display: grid; gap: 6px; color: var(--text-muted); font-size: 11px; }",
        ".engine-summary ul { list-style: none; padding: 0; margin: 10px 0 0; display: grid; gap: 7px; color: var(--text-subtle); font-size: 12px; font-weight: 450; line-height: 1.6; }",
    ),
    (
        ".engine-summary > div { display: flex; align-items: center; gap: 7px; font-size: 12px; }",
        ".engine-summary > div { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: var(--text); }",
    ),
    # Section step labels (01 / Add source etc.)
    (
        ".step-label { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; color: var(--text-secondary); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }",
        ".step-label { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; color: var(--text); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }",
    ),
    # Mode notes / helper copy
    (
        ".mode-note { display: flex; align-items: center; gap: 5px; margin: 8px 0 0; color: var(--text-muted); font-size: 11px; line-height: 1.4; }",
        ".mode-note { display: flex; align-items: center; gap: 5px; margin: 8px 0 0; color: var(--text-subtle); font-size: 12px; line-height: 1.5; }",
    ),
    (
        ".mode-note strong { color: var(--text); }",
        ".mode-note strong { color: var(--text); font-weight: 620; }",
    ),
    # Field helper text
    (
        ".field small { color: var(--text-muted); font-size: 12px; line-height: 1.4; }",
        ".field small { color: var(--text-subtle); font-size: 12px; line-height: 1.45; }",
    ),
    # Panel titles (DETAILS / RULE INSPECTOR)
    (
        ".panel-title strong { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }",
        ".panel-title strong { font-size: 12px; font-weight: 700; color: var(--text); text-transform: uppercase; letter-spacing: .06em; }",
    ),
    # Field labels (Title / Policy / ...)
    (
        ".field-label { font-size: 12px; font-weight: 650; color: var(--text-secondary); }",
        ".field-label { font-size: 12px; font-weight: 650; color: var(--text); }",
    ),
    # Inputs / selects get explicit white text
    (
        "input, textarea, select { width: 100%; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); padding: 10px 11px; }",
        "input, textarea, select { width: 100%; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); padding: 10px 11px; }\nselect option { color: var(--text); background: var(--surface-3); }",
    ),
    # Status badge text
    (
        ".status { display: inline-flex; align-items: center; gap: 5px; width: fit-content; white-space: nowrap; padding: 4px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-secondary); background: var(--surface-2); font-size: 11px; font-weight: 720; letter-spacing: .03em; text-transform: uppercase; }",
        ".status { display: inline-flex; align-items: center; gap: 5px; width: fit-content; white-space: nowrap; padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-secondary); background: var(--surface-2); font-size: 11px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }",
    ),
    # Project card title/meta (the screenshot area)
    (
        ".project-card-title strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
        ".project-card-title strong { font-size: 13px; font-weight: 640; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ),
    (
        ".project-card-body p { margin: 6px 0 3px; color: var(--text-secondary); font-size: 12px; text-transform: capitalize; }",
        ".project-card-body p { margin: 6px 0 3px; color: var(--text-secondary); font-size: 12px; font-weight: 500; text-transform: capitalize; }",
    ),
    (
        ".project-card-body > span { color: var(--text-muted); font-size: 11px; }",
        ".project-card-body > span { color: var(--text-subtle); font-size: 11px; font-weight: 450; }",
    ),
    # Drop zone copy
    (
        ".drop-zone span { font-size: 12px; }",
        ".drop-zone span { font-size: 12px; color: var(--text-subtle); }",
    ),
    # Source card / transcript / beat source in workspace
    (
        ".source-card span { color: var(--text-muted); font-size: 11px; }",
        ".source-card span { color: var(--text-subtle); font-size: 11px; }",
    ),
    (
        ".beat-source-list p { margin: 3px 0 0; color: var(--text-secondary); font-size: 11px; line-height: 1.4; }",
        ".beat-source-list p { margin: 3px 0 0; color: var(--text-secondary); font-size: 12px; font-weight: 450; line-height: 1.5; }",
    ),
    # Clip tiles
    (
        ".clip-tile-body strong { font-size: 11px; }",
        ".clip-tile-body strong { font-size: 12px; font-weight: 620; color: var(--text); }",
    ),
    (
        ".clip-tile-body .clip-line { color: var(--text-secondary); font-size: 11px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
        ".clip-tile-body .clip-line { color: var(--text-secondary); font-size: 11px; font-weight: 450; line-height: 1.45; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ),
    (
        ".clip-tile-body .clip-meta { color: var(--text-muted); font-size: 11px; }",
        ".clip-tile-body .clip-meta { color: var(--text-subtle); font-size: 11px; }",
    ),
    # Jobs page
    (
        ".job-main strong { font-size: 12px; }",
        ".job-main strong { font-size: 13px; font-weight: 640; color: var(--text); }",
    ),
    (
        ".job-main p { margin: 5px 0 7px; color: var(--text-muted); font-size: 11px; text-transform: capitalize; }",
        ".job-main p { margin: 5px 0 7px; color: var(--text-subtle); font-size: 12px; font-weight: 450; text-transform: capitalize; }",
    ),
    # Settings
    (
        ".profile-info strong { font-size: 12px; }",
        ".profile-info strong { font-size: 12px; font-weight: 640; color: var(--text); }",
    ),
    (
        ".profile-info p { margin: 3px 0; color: var(--text-muted); font-size: 11px; }",
        ".profile-info p { margin: 3px 0; color: var(--text-subtle); font-size: 12px; font-weight: 450; line-height: 1.45; }",
    ),
    (
        ".capability-list strong { font-size: 11px; }",
        ".capability-list strong { font-size: 12px; font-weight: 620; color: var(--text); }",
    ),
    (
        ".capability-list > div > div > span { color: var(--text-muted); font-size: 11px; }",
        ".capability-list > div > div > span { color: var(--text-subtle); font-size: 12px; line-height: 1.45; }",
    ),
    # Library sidebar + asset cards
    (
        ".library-sidebar > strong { display: block; padding: 2px 7px 9px; font-size: 11px; text-transform: uppercase; color: var(--text-muted); }",
        ".library-sidebar > strong { display: block; padding: 2px 7px 9px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-secondary); }",
    ),
    (
        ".asset-card strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }",
        ".asset-card strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 620; color: var(--text); }",
    ),
    (
        ".asset-card > button > div > span { color: var(--text-muted); font-size: 11px; }",
        ".asset-card > button > div > span { color: var(--text-subtle); font-size: 11px; }",
    ),
    # Settings card heads
    (
        ".settings-card-head p { margin: 3px 0 0; color: var(--text-muted); font-size: 11px; }",
        ".settings-card-head p { margin: 3px 0 0; color: var(--text-subtle); font-size: 12px; line-height: 1.45; }",
    ),
    # Empty state copy
    (
        ".empty-copy { max-width: 420px; font-size: 12px; margin-bottom: 8px; }",
        ".empty-copy { max-width: 420px; font-size: 12px; line-height: 1.5; margin-bottom: 8px; }",
    ),
    # Workspace source/transcript
    (
        ".transcript-placeholder p { font-size: 12px; line-height: 1.55; }",
        ".transcript-placeholder p { font-size: 12px; font-weight: 450; line-height: 1.6; color: var(--text-secondary); }",
    ),
    # Inspector sections labels (CAPTIONS / SOURCE ...)
    (
        ".inspector-section label { color: var(--text-muted); font-size: 11px; text-transform: uppercase; }",
        ".inspector-section label { color: var(--text-secondary); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }",
    ),
    # Info lists dt
    (
        ".info-list dt, .settings-dl dt { color: var(--text-muted); }",
        ".info-list dt, .settings-dl dt { color: var(--text-subtle); font-weight: 600; }",
    ),
    # File upload copy
    (
        ".script-meta { display: flex; justify-content: space-between; align-items: center; color: var(--text-muted); font-size: 12px; margin-top: 6px; }",
        ".script-meta { display: flex; justify-content: space-between; align-items: center; color: var(--text-subtle); font-size: 12px; margin-top: 6px; }",
    ),
    (
        ".rights-copy { margin: 8px 0 0; text-align: center; color: var(--text-muted); font-size: 11px; }",
        ".rights-copy { margin: 8px 0 0; text-align: center; color: var(--text-subtle); font-size: 11px; }",
    ),
    # Nav labels
    (
        ".nav-item { position: relative; display: grid; place-items: center; gap: 4px; min-height: 57px; border: 0; background: transparent; color: var(--text-muted); font-size: 12px; }",
        ".nav-item { position: relative; display: grid; place-items: center; gap: 4px; min-height: 57px; border: 0; background: transparent; color: var(--text-subtle); font-size: 11px; font-weight: 550; }",
    ),
    (
        ".rail-foot { margin-top: auto; display: grid; justify-items: center; gap: 6px; text-align: center; color: var(--text-muted); font-size: 11px; line-height: 1.2; }",
        ".rail-foot { margin-top: auto; display: grid; justify-items: center; gap: 6px; text-align: center; color: var(--text-subtle); font-size: 10px; line-height: 1.3; }",
    ),
    # Topbar state
    (
        ".save-state { display: flex; align-items: center; gap: 5px; color: var(--text-muted); }",
        ".save-state { display: flex; align-items: center; gap: 5px; color: var(--text-subtle); font-size: 12px; }",
    ),
    # Workspace commandbar
    (
        ".workspace-commandbar strong { font-size: 12px; }",
        ".workspace-commandbar strong { font-size: 13px; font-weight: 640; color: var(--text); }",
    ),
    (
        ".workspace-folder-picker { display: flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 11px; }",
        ".workspace-folder-picker { display: flex; align-items: center; gap: 5px; color: var(--text-subtle); font-size: 11px; }",
    ),
    # Provider callout body
    (
        ".provider-callout > div:nth-child(2) > span { color: var(--text-muted); font-size: 11px; line-height: 1.45; }",
        ".provider-callout > div:nth-child(2) > span { color: var(--text-subtle); font-size: 12px; line-height: 1.5; }",
    ),
    # Score explanation
    (
        ".score-explanation { margin: 11px 0; font-size: 12px; line-height: 1.45; }",
        ".score-explanation { margin: 11px 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }",
    ),
    # Inspector empty
    (
        ".inspector-empty { padding: 13px; font-size: 12px; }",
        ".inspector-empty { padding: 13px; font-size: 12px; line-height: 1.5; }",
    ),
    # Field label small text
    (
        ".field small { color: var(--text-muted); font-size: 12px; line-height: 1.4; }",
        ".field small { color: var(--text-subtle); font-size: 12px; line-height: 1.45; }",
    ),
]
for old, new in readability:
    if old not in css:
        print("WARNING: pattern not found:", old[:80])
    css = css.replace(old, new)

# ---- 5. Add utility classes after .muted ----
css = css.replace(
    ".muted { color: var(--text-muted); }",
    ".muted { color: var(--text-muted); }\n"
    ".small-text { font-size: 12px; line-height: 1.45; font-weight: 450; color: var(--text-muted); }\n"
    ".small-text-important { font-size: 12px; line-height: 1.45; font-weight: 500; color: var(--text-secondary); }\n"
    ".section-eyebrow { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #f0f0f0; }",
)

p.write_text(css, encoding="utf-8")
print("bytes before:", len(orig), "after:", len(css))
print("\nremaining tiny fonts (<=10px):")
for m in re.finditer(r"font-size:\s*(\d+)px", css):
    if int(m.group(1)) <= 10:
        line = css[: m.start()].count("\n") + 1
        print("  line", line, ":", css[max(0, m.start() - 60): m.end()].splitlines()[-1][:100])
