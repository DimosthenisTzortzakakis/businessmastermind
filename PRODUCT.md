# Product

## Register

product

## Users

Dimosthenis (owner of Scrollwise, a media/content agency in Athens) plus 1–2 close collaborators. Expert daily users who know the app inside out — they live in it for income/expense entry, client tracking, and VAT reporting for the Greek market (EUR, Greek VAT rules). Used on desktop at the office and on iPhone on the go. No first-time-visitor hand-holding needed; density and speed win over explanations.

## Product Purpose

Business Mastermind is Scrollwise's internal business tracker: income and expenses per client and sub-client, services rendered, VAT collected/deductible, monthly statistics, and printable PDF reports. It replaces spreadsheets. Success = an entry takes seconds to log, the dashboard answers "how is the month going" at a glance, and reports print clean for the accountant. Data syncs across devices via Firebase with per-account isolation.

## Brand Personality

Premium, dark, technological. The feel is Apple iOS 26 Liquid Glass: deep near-black backgrounds, frosted translucent surfaces, soft specular highlights, an indigo accent. Confident and fast, never playful or cartoonish. The interface should feel like a private, high-end instrument — not a public SaaS.

## Anti-references

- Boring accounting/ERP software: gray, dense, dated, form-heavy screens that feel like paperwork.
- Generic SaaS dashboard templates: identical card grids, hero metrics with gradient accents, eyebrow labels everywhere.
- Anything that makes logging money feel like a chore.

## Design Principles

1. **Speed of entry above all** — Quick Entry and Add Entry flows are the heart of the product; every added click is a regression.
2. **Glance-readable money** — collected, pending, expenses, profit must read in under a second; color codes status (green = paid, amber = pending, red = expense) consistently everywhere.
3. **Glass with restraint** — the Liquid Glass aesthetic is the brand, but blur and translucency serve hierarchy (nav, modals, login), never decoration on data tables.
4. **One source of truth** — every number on screen reflects the same filtered period; period labels are always visible so totals are never ambiguous.
5. **Expert density** — prefer compact, information-rich layouts over whitespace-padded "marketing" spacing; the users are pros.

## Accessibility & Inclusion

- Dark-only theme by design; ensure body text on glass surfaces keeps ≥4.5:1 contrast.
- Touch targets ≥44px on mobile (heavy iPhone use).
- iOS Safari quirks are first-class concerns (number inputs, backdrop-filter, auth redirects).
- Respect `prefers-reduced-motion` for any added animation.
