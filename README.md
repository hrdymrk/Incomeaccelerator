# Incomeaccelerator

Money making software for online.

## Explodely listing workflow

This repository now includes a GitHub-based listing workflow so the product can be prepared from repo data and sent to Explodely with minimal manual work.

### Files

- `/home/runner/work/Incomeaccelerator/Incomeaccelerator/explodely-product.json` - product data source for the listing workflow
- `/home/runner/work/Incomeaccelerator/Incomeaccelerator/scripts/list-explodely.mjs` - Playwright automation that logs into Explodely and fills the product form
- `/home/runner/work/Incomeaccelerator/Incomeaccelerator/.github/workflows/list-explodely.yml` - GitHub Actions workflow for previewing or publishing the listing

### Required GitHub repository secrets

Add these secrets in the repository settings before running the workflow:

- `EXPLODELY_USERNAME`
- `EXPLODELY_PASSWORD`
- `EXPLODELY_BASE_URL` (optional override if your seller portal lives on a different base URL)

### How to use it

#### Preview from GitHub Actions

1. Open the **List product on Explodely** workflow in GitHub Actions.
2. Leave `config_path` as `explodely-product.json` unless you want a different config file.
3. Choose `preview`.
4. Run the workflow.

The workflow will validate the config, open the seller portal, fill the product form, and upload a screenshot artifact without submitting the form.

#### Publish from GitHub Actions

1. Open the **List product on Explodely** workflow in GitHub Actions.
2. Choose `publish`.
3. Run the workflow.

That will fill the form and submit the product listing.

#### Trusted “list it” command

If you comment `list it` on an issue or pull request **as the repository owner**, the workflow will run in publish mode automatically.

### Product data in this repo

The current config is set for:

- Product: `Income Accelerator™`
- Price: `47.00`
- Funnel: `Income Accelerator funnel`
- Affiliate commission: `50%`
- Delivery URL: `https://accelerator.justinpresleycash.biz/income-accelerator-access.html`

### Local validation

To validate the product config locally without logging into Explodely:

```bash
npm install
npm run validate-product
```
