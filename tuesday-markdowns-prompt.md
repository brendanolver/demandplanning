# Prompt for Tuesday (wndrrtuesday): "Markdowns" tab in Sales Promotions

Paste everything below the line into Claude Code, opened in `~/wndrrtuesday`.
The Demand Planning app (v3.3.9+) produces the CSV this prompt imports: Working > Markdowns > Summary > **⬇ Tuesday CSV**.

---

## Goal

Add a **Markdowns** tab to every sale in Sales Promotions (existing sales and new ones). It shows the markdown plan that was built in the Demand Planning app, imported from a CSV, with filters and a PDF export that looks like the Demand Planning Summary.

Read `CLAUDE.md` first (conventions, version bumping, changelog) and follow it. Look at how the **Review** tab (`/sales-checklists/[saleId]/review`), the **Budget** tab and `SaleBudgetCurveImport.tsx` / `validators/sale-budget-import.ts` were built, and mirror those patterns rather than inventing new ones.

## 1. The tab

- In `src/app/(app)/sales-checklists/SalePromotionTabBar.tsx`, add `{ key: "markdowns", label: "Markdowns" }` to `TABS` **between Details and Budget**. The order becomes: Checklist, Calendar, Details, **Markdowns**, Budget, Sending Schedule, Review.
- New route `/sales-checklists/[saleId]/markdowns/page.tsx`, built like the Budget and Review pages (`requireCurrentUser`, `getSaleChecklist`, redirect if the sale is missing, header with the sale name, `<SalePromotionTabBar active="markdowns" />`, metadata title `"{sale} · Markdowns"`).
- "Existing and new" sales need no create or clone step. Every sale reads its own rows, which are empty until a CSV is imported, so a sale made before this shipped just shows the empty state. Do not add anything to the checklist template.

## 2. Data

New schema file `src/db/schema/sale-markdowns-schema.ts` plus a drizzle migration:

- `sale_markdown_rows`: one row per CSV line, `saleId` FK to `sale_checklists.id` (`onDelete: cascade`), `sortOrder` (CSV order), and the columns below.
  - `rowType` is a pg enum: `sale_product`, `special_buy`, `not_on_sale`, `gwp`, `mid_sale_offer`.
  - Money and percentage columns are `numeric`, nullable, because blank is meaningful (blank discount means full price).
  - Everything else is `text` or `integer`.
- `sale_markdown_imports` (one row per sale, upserted): `saleId` unique, `fileName`, `importedAt`, `importedByUserId`, `rowCount`. This feeds the "Last imported …" line.

Importing **replaces** that sale's rows: delete and insert in one transaction, so re-importing after changing the plan is safe and never duplicates. Add a "Clear markdowns" action with a confirm.

## 3. The CSV (exact format)

Header row, in this order (match headers case-insensitively and ignore extra or reordered columns; report missing required ones):

`Sale, Sale Start, Sale End, Row Type, Category, Product, Style, Colour, Month Del, Group, Discount %, Current Disc %, RRP, Sale Price, SOH, On Order, Sales (period), Set Manually, Note, Reason, Offer, Offer Start, Offer End, Offer Rule, Offer Collection, Offer Status, Offer Price, Offer Total Disc %`

- `Row Type` is one of: `Sale product`, `Special buy`, `Not on sale`, `GWP`, `Mid-sale offer`. Reject any other value and report it by line number.
- Required: Row Type, Product, Style. Everything else may be blank.
- Dates are `YYYY-MM-DD`. `Group` is A, B, C, X or blank. `Set Manually` is `Yes` or blank. Money has 2 decimals (no `$`). `Discount %` is a number or blank (blank = stays at full price).
- `Sale product` and `Special buy` rows carry the sale discount and sale price. A special buy whose category is approved arrives as a normal `Sale product` row with Note `special buy` (so it sits in its category's discount group); `Special buy` rows appear only for special buys in categories not yet approved.
- `Not on sale` rows carry a `Reason`.
- `GWP` rows are listed only.
- `Mid-sale offer` rows are one per product per offer. They carry Offer, Offer Start/End, Offer Rule, Offer Collection, Offer Status, Offer Price and Offer Total Disc %. Their `Discount %` and `Sale Price` are the price *before* the offer.
- Parse with a proper CSV reader (quoted commas and newlines). Put the parser in `src/lib/validators/sale-markdowns-import.ts` as a pure function returning `{ rows, errors }`, in the same shape as `sale-budget-import.ts`, with a unit test using the real header above. Show errors and skipped lines in the UI; never import silently.
- The CSV's `Sale` column is informational. Do not match or create sales from it. Import goes into the sale whose tab you are on. If the name differs from the sale, show a non-blocking note ("File is for 'X'").

## 4. The page

Empty state: a short explanation ("Export from Demand Planning > Working > Markdowns > Summary > Tuesday CSV") and an **Import CSV** button.

With data, from top to bottom:

1. **Header strip**: "Last imported {date} by {user} · {n} rows", plus **Import CSV** (replace), **Export PDF** and **Clear**.
2. **Overview cards**: products on sale, SOH units on sale, effective discount, special buys, not on sale, GWP, mid-sale offers.
   - Effective discount is the RRP-weighted average: sum(SOH × RRP × disc%) divided by sum(SOH × RRP) over sale products and special buys.
   - Cards must respect the active filters.
3. **Filters** (client-side, combinable, with a "Clear filters" link and a count such as "212 of 640 rows"):
   - Row Type (multi-select, default all)
   - Category (multi)
   - Discount % (multi; include a "Full price" option)
   - Month Del (multi)
   - Group (A/B/C/X)
   - Set manually (toggle)
   - Offer (multi)
   - Free-text search on product or style
   Reuse the sort and filter components and conventions added in v1.6.11 (`SaleChecklistBoard` filters) rather than writing new ones.
4. **Discount overview table**: discount %, products, SOH, RRP value of stock, discount given, with a totals row. It is built from the filtered rows.
5. **By category**: a collapsible card per category (with a Collapse all / Expand all control), listing products grouped by discount (lowest first, full price last). Group header: "30% off · 12 products · 340 SOH". Columns: Product, Month Del, Group, Discount, Sales, SOH, On Order, RRP, Now, Sale Price, Note. Make every column header click-sortable. Bold the Discount cell where Set Manually = Yes.
6. **Special buys, Not on sale and GWP**: collapsible blocks. Not on sale shows the Reason.
7. **Mid-sale offers**, at the bottom: one collapsible block per offer (name, dates, rule, collection, status), with its products showing Sale disc., Sale Price, Offer Price and Offer Total Disc %.

Follow the existing Tuesday design tokens and table styling (`bg-surface-raised`, `border-border`, `text-text-muted`, accent colours). Use the module's section-colour convention for the category headers and don't invent a new palette. It must work on a laptop-width screen. For large sales (1,000+ rows) the filtering must stay fast; collapse the category blocks by default.

## 5. PDF export

Use **`pdf-lib`**, which is already a dependency (see `src/lib/org-chart-pdf.ts` and `job-description-pdf.ts` for the approach). Build it in `src/lib/sale-markdowns-pdf.ts` as a pure function that takes rows and meta and returns bytes, and serve or download it the way the org chart PDF is.

- A4 **landscape**, 12 mm margins, with the sale name, its dates and a "Generated {date}" line in the title block.
- Same content and order as the page, **reflecting the active filters**. State the filters in a line under the title ("Filtered: Category = TEES, Discount = 30%") so a filtered PDF can't be mistaken for the full plan.
- Overview cards row, then the discount overview table, then each category (grouped by discount), then Special buys / Not on sale / GWP, then Mid-sale offers at the end.
- Tables paginate cleanly: repeat the column headers on every page, never split a row, keep a group header with at least its first row, and put page "n of N" and the sale name in the footer.
- The Product column wraps or truncates rather than overflowing. Bold manual discounts. Use only the standard fonts.
- Filename: `{Sale name} - Markdown plan.pdf`.

## 6. Housekeeping

- Auth: every action calls `requireCurrentUser()`, same as the other sale actions. Put the actions in `src/lib/actions/sale-markdowns.ts` (`getSaleMarkdowns`, `importSaleMarkdowns`, `clearSaleMarkdowns`), with validation of the parsed rows server-side as well.
- Don't change the other tabs, the checklist template or the sidebar nav.
- Add tests for the CSV parser (valid file, quoted commas, bad Row Type, missing required header, blank discount = full price) and for the PDF builder (renders without throwing for 0, 1 and 600 rows, and paginates).
- Verify in local dev: import a real CSV into an existing sale and into a brand-new one, filter, sort, collapse and expand, export a PDF both unfiltered and filtered and open it, re-import a changed CSV and confirm the old rows are replaced, and clear.
- Bump the version, update the changelog in `CLAUDE.md` and follow every step in its version-bump section (check `package.json` first). Commit, push, deploy and run the migration without asking first, as already authorised for this repo.
