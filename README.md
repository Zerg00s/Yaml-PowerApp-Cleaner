# Power Apps Form YAML Cleaner

A single-page app that turns the verbose YAML you copy out of **Power Apps Studio**
(Canvas App forms) into two concise, copy-able outputs:

1. **Cleaned YAML** — only the functional bits (Visible, Update, Items, Default,
   DefaultSelectedItems, Required, DisplayMode, OnSelect/OnChange, control names &
   types, card names, DataField, ValidationState, etc.). All the cosmetic junk — X, Y,
   Width, Height, colors, padding, borders, fonts — and the helper label/error/star
   controls are stripped out.
2. **Markdown docs** — a table of every data card and its input control(s): card
   name, field, the bound SharePoint column, control type, Required, Visible, and the
   non-default functional properties of each control. Buttons are listed in their own
   table (with the data card they belong to). An optional **Diagnostics** section
   surfaces required fields, hidden/conditionally-visible cards, and ⚠️ duplicate field
   bindings.
3. **JSON** — the same structure as machine-readable JSON (often the most
   token-efficient format to feed a model).

Each output tab shows a live **char / token / reduction** stat so you can see how much
context you're saving. **Copy** and **Download** buttons are on every tab. Your filter
choices and last input are remembered between visits (localStorage). Drag the divider
between the panes to resize (double-click to reset).

The goal is quick documentation of how a SharePoint list form was customized — and a
compact, precise format to feed AI models as context without burning tokens.

## Use it

Just open `index.html`. Paste YAML into the left box; the right side updates live.
You can paste either:

- a **whole Form** (`Control: Form@2.4.4`) — the SharePoint list (data source) is
  shown at the top, or
- a **single DataCard** (`Control: TypedDataCard@1.0.7`).

Use the checkboxes at the top to control what the cleaned YAML and Markdown contain.

Everything runs in your browser — nothing is uploaded.

## Host on GitHub Pages

1. Put `index.html`, `app.js`, and `styles.css` in a repo (root or `/docs`).
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*,
   pick your branch and the folder (`/root` or `/docs`).
3. Open the published URL. That's it — it's a static site, no build step.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page markup, filter checkboxes, two output tabs |
| `app.js` | YAML parser + cleaner + Markdown generator + UI wiring |
| `styles.css` | Dark, two-pane layout |

## Notes on the YAML

- The samples are **Classic** controls (`Classic/ComboBox`, `Classic/TextInput`,
  `Classic/DatePicker`, `Classic/DropDown`, `Classic/Toggle`, `Attachments`) inside
  `TypedDataCard` cards. Modern controls (no `Classic/` prefix) are handled the same
  way — the parser keys off the control's `MetadataKey`/type, not the version string.
- A card's human label is recovered by stripping the `_DataCardN` suffix from its
  control name; the bound column is read from `Default: =ThisItem.<column>`.
- The parser understands YAML block scalars (`|-`) used for multi-line formulas.
