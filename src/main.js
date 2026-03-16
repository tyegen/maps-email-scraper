import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter, log } from 'crawlee';

await Actor.init();

const { 
    searchQueries, 
    maxResultsPerQuery = 10, 
    maxWebsitePages = 2,
    maxConcurrency = 10 
} = await Actor.getInput();

const router = createPlaywrightRouter();
const requestQueue = await Actor.openRequestQueue();

// Aggregation map to store results per business
// Format: businessName -> { website, emails: Set, status }
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

router.addHandler('BUSINESS_DETAIL', async ({ page, request }) => {
    const name = await page.$eval('h1', el => el.innerText.trim()).catch(() => 'Unknown');
    let website = await page.evaluate(() => {
        const el = document.querySelector('a[data-item-id="authority"]') 
                || document.querySelector('a[aria-label*="website"]')
                || document.querySelector('a[aria-label*="Web sitesi"]')
                || document.querySelector('a[aria-label*="web sitesi"]')
                || Array.from(document.querySelectorAll('a')).find(a => a.href && !a.href.includes('google.com') && a.innerText.toLowerCase().includes('website'));
        return el ? el.href : null;
    });

    website = cleanWebsiteUrl(website);
    log.info(`Business: ${name}`);

    // Initialize in map
    resultsMap.set(name, { website, emails: new Set(), status: 'processing' });

    if (website && !['facebook.com', 'instagram.com', 'twitter.com', 'linkedin.com', 'youtube.com'].some(d => website.includes(d))) {
        await requestQueue.addRequest({
            url: website,
            label: 'EXTRACT_EMAILS',
            userData: { businessName: name, website, pagesCrawled: 0 },
        });
    } else {
        resultsMap.get(name).status = website ? 'skipped domain' : 'no website';
    }
});

router.addHandler('EXTRACT_EMAILS', async ({ page, request, enqueueLinks }) => {
    const { businessName, website, pagesCrawled } = request.userData;
    
    const html = await page.content();
    const mailto = await page.$$eval('a[href^="mailto:"]', (els) => els.map(el => el.href.replace('mailto:', '').split('?')[0].trim()));
    const pageEmails = html.match(/[a-zA-Z0-9._%+-]+@(?![0-9.])[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    
    const res = resultsMap.get(businessName);
    if (res) {
        [...mailto, ...pageEmails].forEach(e => {
            const clean = e.toLowerCase().trim();
            if (clean.includes('@') && !clean.match(/\.(png|jpg|jpeg|gif|svg|webp|woff|ttf|css|js)$/)) {
                res.emails.add(clean);
            }
        });
    }

    // Crawl subpages if emails not found enough or just search for more
    if (pagesCrawled < maxWebsitePages) {
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
                    if (/\.(pdf|zip|jpg|png|jpeg|docx?|xlsx?|woff2?|ttf|svg|css|js)$/i.test(u.pathname)) return false;
                    return req;
                } catch(e) {}
                return false;
            }
        });
    }
    
    if (res && res.emails.size > 0) res.status = 'success';
    else if (res && res.status === 'processing') res.status = 'searching...';
});

const crawler = new PlaywrightCrawler({
    requestHandler: router,
    maxConcurrency,
    requestHandlerTimeoutSecs: 60,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--disable-features=IsolateOrigins,site-per-process'],
        },
    },
    browserPoolOptions: { useFingerprints: true },
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
