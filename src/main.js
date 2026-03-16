import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter, log } from 'crawlee';

await Actor.init();

const { 
    searchQueries, 
    maxResultsPerQuery = 10, 
    maxWebsitePages = 2, // Keep it low for speed
    maxConcurrency = 10 
} = await Actor.getInput();

const router = createPlaywrightRouter();
const requestQueue = await Actor.openRequestQueue();

// Track processed businesses to avoid duplicate entries in final dataset
const resultsMap = new Map();

function cleanWebsiteUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        if (u.hostname.includes('google.com') && u.pathname.includes('/url')) {
            const q = u.searchParams.get('q');
            return q ? q : url;
        }
    } catch (e) {}
    return url;
}

router.addHandler('MAPS_SEARCH', async ({ page, request, enqueueLinks }) => {
    log.info(`Searching: ${request.userData.query}`);
    
    // Quick handle cookie consent
    const cookieButton = await page.$('button[aria-label*="Accept"], button[aria-label*="Kabul"], button[id*="L2AGLb"]');
    if (cookieButton) await cookieButton.click();

    await page.waitForSelector('div[role="feed"]', { timeout: 15000 }).catch(() => {});
    
    // Fast efficient scroll
    await page.evaluate(async (max) => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return;
        let lastCount = 0;
        let stagnated = 0;
        while (stagnated < 5) {
            const currentCount = document.querySelectorAll('div[role="article"]').length;
            if (currentCount >= max) break;
            if (currentCount === lastCount) stagnated++;
            else stagnated = 0;
            lastCount = currentCount;
            feed.scrollBy(0, 1500);
            await new Promise(r => setTimeout(r, 1000));
        }
    }, maxResultsPerQuery);

    const links = await page.$$eval('div[role="article"] a', (els) => {
        return els.filter(el => el.href && el.href.includes('/maps/place/')).map(el => el.href);
    });

    const uniqueLinks = [...new Set(links)].slice(0, maxResultsPerQuery);
    log.info(`Found ${uniqueLinks.length} businesses.`);

    for (const url of uniqueLinks) {
        await enqueueLinks({
            urls: [url],
            label: 'BUSINESS_DETAIL',
            userData: { query: request.userData.query }
        });
    }
});

router.addHandler('BUSINESS_DETAIL', async ({ page, request, log }) => {
    // No long wait here, just wait for H1
    await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});
    const name = await page.$eval('h1', el => el.innerText.trim()).catch(() => 'Unknown');
    
    let website = await page.evaluate(() => {
        const el = document.querySelector('a[data-item-id="authority"]') 
                || document.querySelector('a[aria-label*="website"]')
                || document.querySelector('a[aria-label*="Web sitesi"]')
                || document.querySelector('a[aria-label*="web sitesi"]')
                || Array.from(document.querySelectorAll('a')).find(a => a.href && !a.href.includes('google.com') && (a.innerText.toLowerCase().includes('site') || a.innerText.toLowerCase().includes('web')));
        return el ? el.href : null;
    });

    website = cleanWebsiteUrl(website);
    log.info(`Business Found: ${name}`);

    // Standardize name for Map key to avoid casing duplicates
    const mapKey = name.toLowerCase().trim();
    if (!resultsMap.has(mapKey)) {
        resultsMap.set(mapKey, { businessName: name, website, emails: new Set(), status: 'processing' });
    } else {
        log.info(`Business ${name} already in results, skipping.`);
        return;
    }

    if (website && !['facebook.com', 'instagram.com', 'twitter.com', 'linkedin.com', 'youtube.com', 'tiktok.com'].some(d => website.includes(d))) {
        await requestQueue.addRequest({
            url: website,
            label: 'EXTRACT_EMAILS',
            userData: { businessName: name, website, pagesCrawled: 0 },
        });
    } else {
        resultsMap.get(mapKey).status = website ? 'skipped (social/google)' : 'no website';
    }
});

router.addHandler('EXTRACT_EMAILS', async ({ page, request, log, enqueueLinks }) => {
    const { businessName, website, pagesCrawled } = request.userData;
    const mapKey = businessName.toLowerCase().trim();
    const res = resultsMap.get(mapKey);

    // If we already have emails and want to be FAST, we could stop here. 
    // But let's at least finish the current page.
    
    const html = await page.content();
    const mailto = await page.$$eval('a[href^="mailto:"]', (els) => els.map(el => el.href.replace('mailto:', '').split('?')[0].trim()));
    const pageEmails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    
    if (res) {
        [...mailto, ...pageEmails].forEach(e => {
            const clean = e.toLowerCase().trim();
            // Filter out common junk and duplicates handled by Set
            if (clean.includes('@') && clean.includes('.') && !clean.match(/\.(png|jpg|jpeg|gif|svg|webp|woff|ttf|css|js|ico)$/)) {
                res.emails.add(clean);
            }
        });
    }

    // Speed optimization: If emails found on homepage, DON'T crawl subpages unless depth is forced
    const foundAny = res && res.emails.size > 0;
    
    if (!foundAny && pagesCrawled < maxWebsitePages) {
        await enqueueLinks({
            limit: 3,
            selector: 'a',
            label: 'EXTRACT_EMAILS',
            userData: { ...request.userData, pagesCrawled: pagesCrawled + 1 },
            transformRequestFunction: (req) => {
                try {
                    const u = new URL(req.url);
                    const b = new URL(website);
                    if (u.hostname.replace('www.', '') !== b.hostname.replace('www.', '')) return false;
                    // Aggressive filter
                    if (/\.(pdf|zip|jpg|png|jpeg|docx?|xlsx?|woff2?|ttf|svg|css|js|mp4|mp3|wav)$/i.test(u.pathname)) return false;
                    // Ignore login/cart/etc.
                    if (['login', 'cart', 'checkout', 'account', 'register'].some(w => u.pathname.toLowerCase().includes(w))) return false;
                    return req;
                } catch(e) {}
                return false;
            }
        });
    }
    
    if (res) {
        if (res.emails.size > 0) res.status = 'success';
        else if (res.status === 'processing') res.status = 'no emails found';
    }
});

const crawler = new PlaywrightCrawler({
    requestHandler: router,
    maxConcurrency,
    // Lower timeouts for speed
    requestHandlerTimeoutSecs: 45,
    navigationTimeoutSecs: 30,
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--disable-dev-shm-usage', 
                '--no-sandbox', 
                '--disable-gpu', 
                '--disable-features=IsolateOrigins,site-per-process',
                '--blink-settings=imagesEnabled=false', // Hard block images in browser engine
            ],
        },
    },
    browserPoolOptions: { 
        useFingerprints: true,
        // Kill browsers faster to free CPU
        operationTimeoutSecs: 30,
    },
    preNavigationHooks: [
        async ({ blockRequests }) => {
            await blockRequests({
                urlPatterns: ['.jpg', '.jpeg', '.png', '.svg', '.gif', '.css', '.woff', '.pdf', '.zip', 'analytics', 'facebook', 'google-analytics'],
            });
        },
    ],
});

log.info('Starting...');
await crawler.run(searchQueries.map(q => ({
    url: `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
    label: 'MAPS_SEARCH',
    userData: { query: q }
})));

// Push aggregated results to dataset
log.info('Finalizing results...');
const finalResults = [];
for (const [name, data] of resultsMap.entries()) {
    finalResults.push({
        businessName: name,
        website: data.website,
        emails: [...data.emails],
        status: data.emails.size > 0 ? 'success' : data.status
    });
}
await Dataset.pushData(finalResults);
log.info(`Done. Pushed ${finalResults.length} unique businesses.`);

await Actor.exit();
