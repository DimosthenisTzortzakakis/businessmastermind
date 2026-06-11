# Design

## Visual Theme

**Liquid Glass, dark-only.** Apple iOS 26-inspired: a near-black indigo-tinted base (`#040410`) with four large blurred gradient blobs (indigo, violet, magenta, cyan) fixed behind everything, creating an iridescent depth. All chrome surfaces (sidebar, topbar, modals, bottom nav, login card) are frosted glass: low-alpha white fills + `backdrop-filter: blur(28–48px) saturate(180–200%)` + a 1px top specular highlight (`inset 0 1px 0 rgba(255,255,255,0.12–0.2)`). Content cards use translucent white fills without heavy blur so data stays crisp.

## Color Palette

| Role | Token | Value |
|---|---|---|
| Background | `--bg` | `#040410` |
| Card surface | `--bg-card` | `rgba(255,255,255,0.07)` |
| Card surface 2 | `--bg-card2` | `rgba(255,255,255,0.04)` |
| Border | `--border` | `rgba(255,255,255,0.13)` |
| Accent (brand) | `--accent` | `#6366f1` (indigo) |
| Accent hover | `--accent-hover` | `#818cf8` |
| Positive / Paid | `--green` | `#10b981` |
| Negative / Expense | `--red` | `#ef4444` |
| Pending | `--amber` | `#f59e0b` |
| Info | `--blue` | `#3b82f6` |
| Text | `--text` | `#f1f5f9` |
| Text muted | `--text-muted` | `#94a3b8` |
| Text faint | `--text-faint` | `#475569` |

Each status color has a `-light` rgba(…,0.15–0.18) tint for badges/backgrounds. Semantics are fixed: green = money in / paid, amber = pending, red = money out / expense, indigo = interactive/brand. Gradients (accent → `#8b5cf6`) appear only on primary CTAs and the login logo.

## Typography

- **Family:** Inter (Google Fonts), weights 300–800. Single-family system; hierarchy via weight and size only.
- **Body:** 13–14px, weight 400–500, `--text` on dark.
- **Headings/section titles:** 600–800 weight; section titles often 13–14px uppercase with letter-spacing.
- **Numbers/money:** 700–800 weight, larger sizes; currency always shown (€).
- **Micro-labels** (period badges, table sub-labels): 9–11px, 600–700 weight, uppercase, `--text-faint`/`--text-muted`.

## Components

- **Sidebar** (240px, desktop): glass panel, icon + label nav items, active item gets `--sidebar-item-active` indigo tint. User chip + sign-out at bottom.
- **Topbar** (64px): glass, page title centered, search field + primary "Add Entry" pill button right.
- **Bottom nav** (72px, mobile): glass bar replacing the sidebar.
- **Cards:** `--radius` 16px, `--bg-card` fill, 1px `--border`, `--shadow` with specular inset. Stat cards have a colored icon chip top-left.
- **Sheets/modals:** bottom sheets on mobile, dialogs on desktop; heavy glass (`blur(44px)`), 0.84+ alpha backgrounds for readability.
- **Buttons:** primary = indigo gradient pill; secondary = translucent white glass; destructive = red tint. `--radius-sm` 10px / 14px for large.
- **Inputs:** translucent fills (`rgba(255,255,255,0.04–0.07)`), 1px borders, indigo focus ring; iOS-safe (`-webkit-text-fill-color`, `appearance: none`).
- **Badges:** pill-shaped, status-color `-light` background + matching border and text (e.g. stats period badge).
- **Charts (Chart.js):** doughnuts + bars; segment borders `rgba(255,255,255,0.08)`; legend text `#94a3b8` 11px Inter.

## Layout

- App shell: fixed sidebar (desktop) / bottom nav (mobile), fixed glass topbar, scrollable content area.
- Dashboard: month-filter pill row → 4 stat cards → VAT strip → two overview columns → Statistics (charts grid + 3 ranking tables).
- Radii scale: 6 / 10 / 16px (xs / sm / default), 20–28px for hero surfaces (login card).
- Transition standard: `0.2s cubic-bezier(0.4,0,0.2,1)`; hovers lift 1px with stronger shadow.
- Z-order: content < sticky chrome < sheets/dialogs < login screen.
