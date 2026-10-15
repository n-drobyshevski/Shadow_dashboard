# Design direction — "audit ledger"

This is an internal compliance tool used by one person (and shown to managers) to track unmanaged
workstations and software in industrial labs. It should feel like a **well-typeset audit report that
you can edit**, not like a SaaS marketing dashboard. The reference points are printed engineering
ledgers, Swiss-style reports and good terminal UIs — dense, calm, precise, honest about data.

This file **overrides** any visual instruction in `docs/API.md` (emoji icons, "cards", badges,
gauge styling, copy with emoji). Data, behaviour and API contracts are unchanged.

## What to avoid (the "AI-generated dashboard" look)
- Emoji anywhere in the UI chrome: nav, headings, buttons, toasts, empty states, form labels.
  (Only exception: none. The brand is the word "Shadow IT", not 👻.)
- "Card soup": every block in a rounded white box with a soft drop shadow. No `box-shadow` for
  elevation except on true overlays (modal, drawer, dropdown, toast).
- Coloured top/left accent borders on cards, gradient fills, glassmorphism, blurred backdrops,
  pastel tinted panels behind everything, pill badges for every value, big rounded radii (> 4px).
- Decorative chart chrome: gauges/donuts as hero visuals, rainbow palettes, chart titles inside
  plots, gridlines everywhere, legends when labels can be direct.
- Centered floating "hero" forms (the config screen), illustrated empty states, marketing copy
  ("Supercharge…", "Effortlessly…"), exclamation marks, "✅ Success!" toasts.
- Generic Inter-on-white with uniform 600 weights; icon + label everywhere.

## Principles
1. **Type and rules do the structure.** Hierarchy comes from typography, alignment and 1px hairline
   rules, not boxes. Sections are separated by a rule and a small-caps label.
2. **Numbers are the interface.** Tabular figures, right-aligned numerics, monospace for identifiers
   (poste names, months, dates, scores). Big figures only for the 4 headline KPIs.
3. **Colour is data, not decoration.** The UI is ink-on-paper neutral. Colour appears only to encode
   status (conforme / non conforme, risk level) and for the single interactive accent.
4. **Density with air.** Compact rows (32px), generous outer margins, consistent 8px grid.
5. **Plain French.** Short, factual, no emoji, no exclamation marks. « Import terminé — 7 postes,
   5 applications. » not « ✅ Import réussi ! ».

## Tokens
```
--ink:        #16181b   primary text, primary button, conforming data
--ink-2:      #4a4f57   secondary text
--ink-3:      #7c828b   tertiary text, axis labels
--rule:       #e3e4e6   hairlines
--rule-2:     #c9cbcf   stronger rules, input borders
--paper:      #ffffff   main surface
--paper-2:    #f6f6f4   sidebar, table header, subtle zones (the ONLY tinted surface)
--accent:     #0b63ce   links, focus ring, selected nav, primary actions (one blue, used sparingly)
--ok:         #1f7a4d   conforme (text/marks)          --ok-bg: #e8f3ec (rarely, only inline marks)
--ko:         #b42318   non conforme (text/marks)      --ko-bg: #fbeceb
--warn:       #a15c07   overdue / warning
--risk-critique #b42318  --risk-eleve #d4621b  --risk-moyen #c99a06  --risk-faible #1f7a4d
--radius: 3px (inputs, buttons); 0 for tables and sections; 6px only for modal/drawer
--font-sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif
--font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace
Type scale: 12 / 13 (base, tables) / 14 (body) / 16 / 20 (page title) / 32 (KPI figures)
Weights: 400 and 500 (600 only for the page title). Letter-spacing +0.06em on small-caps labels.
font-variant-numeric: tabular-nums on everything numeric.
```
Load the fonts from Google Fonts in `index.html`
(`https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap`)
with the system fallbacks above.

## Components
- **Sidebar**: `--paper-2`, full viewport height (sticky), 1px right rule. Wordmark "Shadow IT" in
  mono 500 with a small "Industry · conformité" subtitle. Nav = plain text links with a 2px ink bar
  on the left of the active item; numbers on the right showing counts are allowed (e.g. postes 7).
  Period + filters below a small-caps "PÉRIODE" / "FILTRES" label. Footer: text links to the data
  sheet and the source sheet, "Changer de source" as a text button.
- **Page header**: small-caps breadcrumb/month line (`MAI 2026 · EXPORT 2026-05`) above a 20px title.
  A hairline below. Page-level actions right-aligned, as text or outline buttons.
- **KPI strip** (dashboard): one row, 4 columns divided by vertical hairlines, no boxes. Label in
  small caps `--ink-3`; figure 32px mono/tabular `--ink`; under it the rate in `--ok`/`--ko` with a
  tiny ▲/▼ only if comparing to the previous month (never decorative arrows).
- **Section**: `<section>` with a small-caps label + hairline on top; content flows on paper.
  Two-column grids via CSS grid with a vertical hairline gap, not boxes.
- **Compliance meters** (replace gauges): horizontal *bullet charts* — a 10px track in `--rule`, a bar
  in `--ok` if ≥ 80 else `--ko`, a 2px ink tick at 80 labelled "seuil 80 %", value as a mono figure
  at the right. Same data as the original gauges, honest and compact. (Plain HTML/CSS is fine.)
- **Risk distribution**: horizontal bars, one row per level in `RISK_ORDER`, bar coloured by the risk
  token, count as a mono figure at the bar end. No axes, no gridlines.
- **Score histogram**: thin vertical bars on fixed 0–100 bins; bins below 80 in `--ko` at 70 % opacity,
  at/above 80 in `--ok`; dashed ink line at 80 labelled "seuil 80 %"; x-axis ticks only; no y gridlines
  (a light baseline only). Plotly `layout`: `font.family` = sans, `paper_bgcolor`/`plot_bgcolor`
  transparent, `margin` tight, `displayModeBar:false`.
- **Line charts** (timeline): ink for postes, `--ink-3` dashed for applications, threshold as a
  dotted rule labelled at the right edge; direct labels on the last point instead of a legend.
- **Heatmap**: sequential single-hue (white → `--ok` for % conformes) with the % printed in cells in
  mono; no colour bar unless needed.
- **Tables**: full-width, no outer border, header row on `--paper-2` in small caps 12px, rows 32px with
  hairline separators, no zebra. Identifiers in mono. Numbers right-aligned. Editable cells show a
  dotted underline on hover; edited cells get a 2px `--accent` left inset + the dirty bar.
  Status = coloured text + 6px square marker (■), not pills. Score = mono figure coloured ok/ko.
- **Status marks**: `■ Conforme` (`--ok`), `■ Non conforme` (`--ko`), risk `■ Critique`… with the
  risk colour. Use a pill (`--ok-bg`/`--ko-bg`, 2px radius) only in dense table cells if needed.
- **Buttons**: 32px tall, 3px radius. Primary = `--ink` background, white text. Secondary = 1px
  `--rule-2` border on paper. Destructive = `--ko` text, outline. Text buttons for low-priority
  actions. No icons-only buttons except close (×) with aria-label.
- **Inputs/selects**: 1px `--rule-2`, 3px radius, 32px tall, focus = 2px `--accent` outline offset 1px.
- **Modal / drawer**: the only elevated surfaces (shadow `0 12px 32px rgba(0,0,0,.18)`), 6px radius
  (drawer: none, full height, 1px left rule). Backdrop `rgba(22,24,27,.35)`, no blur.
- **Toasts**: bottom-left, ink background, white text, 3px radius, no icons; errors get a `--ko`
  left bar.
- **Config screen**: left-aligned within the main column like any page: title "Source de données",
  one paragraph, the input (full width up to 640px) and one primary button. No centered card.
- **Empty states**: one line of `--ink-2` text (plus an action link if relevant), left-aligned.
- **Detail lists** (Détail conformité): definition-list rows `label …… count (xx,x %)` with a dotted
  leader, mono figures right-aligned; expandable rows reveal the affected names inline.

## Copy
- Titles: « Tableau de bord », « Postes », « Applications », « Suivi temporel », « Suivi des actions ».
- Buttons: « Importer », « Ré-importer », « Enregistrer », « Annuler », « Ajouter un poste générique »,
  « Nouvelle application », « Renommer », « Supprimer », « Exporter CSV », « Nouvelle action ».
- Toasts: « Import terminé — 7 postes, 5 applications. », « 3 modifications enregistrées. »,
  « Erreur : <message> ».
- Numbers fr-FR: `71,4 %` (narrow no-break space before %), thousands with narrow no-break space.

## Accessibility
Contrast ≥ 4.5:1 for text (all tokens above pass on `--paper`), visible focus ring on everything
interactive, never colour-only status (always text + colour), `prefers-reduced-motion` respected,
touch targets ≥ 32px, works at 390px wide (sidebar becomes a top bar with a menu button).
