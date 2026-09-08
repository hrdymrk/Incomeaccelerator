import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry-run');
const rootDir = process.cwd();
const defaultConfigPath = process.env.EXPLODELY_PRODUCT_CONFIG || 'explodely-product.json';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function buildUrl(baseUrl, pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  return `${normalizeBaseUrl(baseUrl)}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
}

async function readConfig(configPath) {
  const absolutePath = path.resolve(rootDir, configPath);
  const file = await fs.readFile(absolutePath, 'utf8');
  const config = JSON.parse(file);

  return {
    absolutePath,
    config
  };
}

function validateConfig(config) {
  const requiredFields = [
    'productName',
    'price',
    'currency',
    'offerSummary',
    'description',
    'deliveryUrl'
  ];

  const missing = requiredFields.filter((field) => !String(config[field] || '').trim());

  if (missing.length > 0) {
    throw new Error(`Missing required fields in product config: ${missing.join(', ')}`);
  }

  if (Number.isNaN(Number(config.price))) {
    throw new Error('Product price must be numeric.');
  }

  if (!/^https?:\/\//i.test(config.deliveryUrl)) {
    throw new Error('Delivery URL must start with http:// or https://.');
  }
}

function buildProductDescription(config) {
  return [config.offerSummary, config.bonusHeadline, config.description]
    .filter(Boolean)
    .join('\n\n');
}

function ownerCommandDetected() {
  return process.env.GITHUB_EVENT_NAME === 'issue_comment';
}

function shouldSkipSubmit() {
  if (process.env.EXPLODELY_SKIP_SUBMIT) {
    return process.env.EXPLODELY_SKIP_SUBMIT === 'true';
  }

  return !ownerCommandDetected();
}

async function ensureDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

async function locatorVisible(locator) {
  try {
    return (await locator.count()) > 0 && await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function tryFill(locator, value) {
  try {
    const target = locator.first();
    await target.scrollIntoViewIfNeeded();
    const tagName = await target.evaluate((element) => element.tagName.toLowerCase());

    if (tagName === 'select') {
      await target.selectOption({ label: String(value) }).catch(async () => {
        await target.selectOption({ value: String(value) });
      });
      return true;
    }

    await target.fill(String(value));
    return true;
  } catch {
    return false;
  }
}

async function tryClick(locator) {
  try {
    const target = locator.first();
    await target.scrollIntoViewIfNeeded();
    await target.click();
    return true;
  } catch {
    return false;
  }
}

function buildFieldLocators(page, hints) {
  const locators = [];

  for (const hint of hints) {
    const regex = new RegExp(escapeRegex(hint), 'i');
    const slug = hint.toLowerCase().replace(/[^a-z0-9]+/g, '');

    locators.push(page.getByLabel(regex));
    locators.push(page.getByPlaceholder(regex));
    locators.push(page.getByRole('textbox', { name: regex }));
    locators.push(page.getByRole('combobox', { name: regex }));
    locators.push(page.locator(`input[name*="${slug}" i], textarea[name*="${slug}" i], select[name*="${slug}" i]`));
    locators.push(page.locator(`[aria-label*="${hint}" i], [placeholder*="${hint}" i]`));
  }

  return locators;
}

async function fillField(page, label, value, hints, options = {}) {
  if (value === undefined || value === null || value === '') {
    return false;
  }

  const locators = buildFieldLocators(page, hints);

  for (const locator of locators) {
    if (await locatorVisible(locator) && await tryFill(locator, value)) {
      console.log(`Filled ${label}`);
      return true;
    }
  }

  if (options.required) {
    throw new Error(`Unable to find a visible field for ${label}.`);
  }

  console.warn(`Skipped ${label}; no matching field was visible.`);
  return false;
}

async function clickAction(page, label, hints, options = {}) {
  for (const hint of hints) {
    const regex = new RegExp(escapeRegex(hint), 'i');
    const locators = [
      page.getByRole('button', { name: regex }),
      page.getByRole('link', { name: regex }),
      page.getByText(regex)
    ];

    for (const locator of locators) {
      if (await locatorVisible(locator) && await tryClick(locator)) {
        console.log(`Clicked ${label}`);
        return true;
      }
    }
  }

  if (options.required) {
    throw new Error(`Unable to find a visible action for ${label}.`);
  }

  return false;
}

async function productFormVisible(page) {
  const checks = buildFieldLocators(page, ['Product Name', 'Name', 'Product Price', 'Price']);

  for (const locator of checks) {
    if (await locatorVisible(locator)) {
      return true;
    }
  }

  return false;
}

async function navigateToProductForm(page, config) {
  const baseUrl = normalizeBaseUrl(process.env.EXPLODELY_BASE_URL || config.portal?.baseUrl || 'https://explodely.com');
  const productsUrl = buildUrl(baseUrl, config.portal?.productsPath || '/seller/products');

  await page.goto(productsUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (await productFormVisible(page)) {
    return;
  }

  if (await clickAction(page, 'products navigation', ['Products', 'Seller Hub'], { required: false })) {
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  if (await clickAction(page, 'new product button', ['Add Product', 'Create Product', 'New Product'], { required: false })) {
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  if (await productFormVisible(page)) {
    return;
  }

  throw new Error('Could not reach the Explodely product form. Set portal paths to match your seller account if they differ.');
}

async function login(page, config) {
  const username = process.env.EXPLODELY_USERNAME;
  const password = process.env.EXPLODELY_PASSWORD;

  if (!username || !password) {
    throw new Error('EXPLODELY_USERNAME and EXPLODELY_PASSWORD secrets are required for non-dry-run execution.');
  }

  const baseUrl = normalizeBaseUrl(process.env.EXPLODELY_BASE_URL || config.portal?.baseUrl || 'https://explodely.com');
  const loginUrl = buildUrl(baseUrl, config.portal?.loginPath || '/seller/signin');

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await fillField(page, 'username', username, ['Username', 'Email', 'Email Address'], { required: true });
  await fillField(page, 'password', password, ['Password'], { required: true });
  await clickAction(page, 'sign in', ['Sign In', 'Login', 'Log In'], { required: true });
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function listProduct(config) {
  const artifactsDir = path.join(rootDir, 'artifacts');
  await ensureDirectory(artifactsDir);

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  const publish = !shouldSkipSubmit();

  try {
    await login(page, config);
    await navigateToProductForm(page, config);

    await fillField(page, 'product name', config.productName, ['Product Name', 'Name'], { required: true });
    await fillField(page, 'description', buildProductDescription(config), ['Product Description', 'Description'], { required: true });
    await fillField(page, 'price', config.price, ['Product Price', 'Price'], { required: true });
    await fillField(page, 'currency', config.currency, ['Currency'], { required: false });
    await fillField(page, 'affiliate commission', config.affiliateCommissionPercent, ['Affiliate Commission', 'Commission', 'Commission Percent', 'Revshare'], { required: false });
    await fillField(page, 'funnel', config.funnelName, ['Funnel', 'Assigned Funnel'], { required: false });
    await fillField(page, 'delivery url', config.deliveryUrl, ['Delivery URL', 'Access URL', 'Redirect URL', 'URL'], { required: true });

    const screenshotPath = path.join(artifactsDir, publish ? 'explodely-ready-to-submit.png' : 'explodely-preview.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    if (!publish) {
      console.log(`Preview completed without submitting. Screenshot saved to ${screenshotPath}`);
      return;
    }

    await clickAction(page, 'save product', ['Create Product', 'Add Product', 'Save Product', 'Submit', 'Publish'], { required: true });
    await page.waitForLoadState('networkidle').catch(() => {});

    const submittedScreenshotPath = path.join(artifactsDir, 'explodely-submitted.png');
    await page.screenshot({ path: submittedScreenshotPath, fullPage: true });
    console.log(`Product submitted. Screenshot saved to ${submittedScreenshotPath}`);
  } catch (error) {
    const errorScreenshotPath = path.join(artifactsDir, 'explodely-error.png');
    await page.screenshot({ path: errorScreenshotPath, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

async function main() {
  const { absolutePath, config } = await readConfig(defaultConfigPath);
  validateConfig(config);

  if (dryRun) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      configPath: absolutePath,
      publishTriggeredByTrustedComment: ownerCommandDetected(),
      productName: config.productName,
      price: config.price,
      currency: config.currency,
      affiliateCommissionPercent: config.affiliateCommissionPercent,
      funnelName: config.funnelName,
      deliveryUrl: config.deliveryUrl,
      descriptionPreview: buildProductDescription(config)
    }, null, 2));
    return;
  }

  await listProduct(config);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
