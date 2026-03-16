import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter, log as crawleeLog } from 'crawlee';

await Actor.init();

const { 
    searchQueries, 
    maxResultsPerQuery = 10, 
    maxWebsitePages = 3,
    maxConcurrency = 5 
} = await Actor.getInput();

const router = createPlaywrightRouter();
const requestQueue = await Actor.openRequestQueue();

// Helper to clean Google redirect URLs
function cleanWebsiteUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        if (u.hostname.includes('google.com') && u.pathname.includes('/url')) {
            const q = u.searchParams.get('q');
            return q ? q : url;
        }
    } catch (e) {
        // ignore
    }
    return url;
}

router.addHandler('MAPS_SEARCH', async ({ page, request, enqueueLinks }) => {
    crawleeLog.info(`Searching Google Maps for: ${request.userData.query}`);
    
    // Cookie consent
    const cookieButton = await page.$('button[aria-label*="Accept"], button[aria-label*="Kabul"]');
    if (cookieButton) {
        await cookieButton.click();
        await page.waitForTimeout(2000);
    }

    await page.waitForSelector('div[role="feed"]', { timeout: 30000 }).catch(() => crawleeLog.error('Feed not found'));
    
    // More aggressive scroll
    await page.evaluate(async (max) => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return;
        
        let lastCount = 0;
        let stagnated = 0;
        
        while (stagnated < 10) {
            const currentCount = document.querySelectorAll('div[role="article"]').length;
            if (currentCount >= max) break;
            
            if (currentCount === lastCount) {
                stagnated++;
            } else {
                stagnated = 0;
            }
            
            lastCount = currentCount;
            feed.scrollBy(0, 1000);
            await new Promise(r => setTimeout(r, 1500));
        }
    }, maxResultsPerQuery);

    const links = await page.$$eval('div[role="article"] a', (els) => {
        return els.filter(el => el.href && el.href.includes('/maps/place/')).map(el => el.href);
    });

    const uniqueLinks = [...new Set(links)].slice(0, maxResultsPerQuery);
    crawleeLog.info(`Found ${uniqueLinks.length} businesses.`);

    for (const url of uniqueLinks) {
        await enqueueLinks({
            urls: [url],
            label: 'BUSINESS_DETAIL',
            userData: { query: request.userData.query }
        });
    }
});

router.addHandler('BUSINESS_DETAIL', async ({ page, request, log }) => {
    log.info(`Processing business detail: ${request.url}`);
    await page.waitForTimeout(2000);

    const name = await page.$eval('h1', el => el.innerText.trim()).catch(() => 'Unknown');
    let website = await page.evaluate(() => {
        const el = document.querySelector('a[data-item-id="authority"]') 
                || document.querySelector('a[aria-label*="website"]')
                || document.querySelector('a[aria-label*="Web sitesi"]')
                || document.querySelector('a[aria-label*="web sitesi"]');
        return el ? el.href : null;
    });

    // CRITICAL: Clean Google redirect URLs
    website = cleanWebsiteUrl(website);

    log.info(`Business: ${name}, Website: ${website || 'N/A'}`);

    if (website) {
        const urlObj = new URL(website);
        const domain = urlObj.hostname.toLowerCase();
        const blacklisted = ['google.com', 'gstatic.com', 'facebook.com', 'instagram.com', 'twitter.com', 'linkedin.com', 'youtube.com'];
        
        if (!blacklisted.some(b => domain.includes(b))) {
            log.info(`Enqueuing website for email extraction: ${website}`);
            await requestQueue.addRequest({
                url: website,
                label: 'EXTRACT_EMAILS',
                userData: { businessName: name, website, pagesCrawled: 0 },
                uniqueKey: website.replace('www.', '').split(/[?#]/)[0]
            });
        } else {
             log.warning(`Skipping social media or google domain for ${name}: ${website}`);
             await Dataset.pushData({ businessName: name, website, emails: [], status: 'skipped (social/google domain)' });
        }
    } else {
        await Dataset.pushData({ businessName: name, website: null, emails: [], status: 'no website found' });
    }
});

router.addHandler('EXTRACT_EMAILS', async ({ page, request, log, enqueueLinks }) => {
    const { businessName, website, pagesCrawled } = request.userData;
    log.info(`Crawling website: ${request.url} (Depth: ${pagesCrawled})`);

    const html = await page.content();
    const mailtoEmails = await page.$$eval('a[href^="mailto:"]', (els) => 
        els.map(el => el.href.replace('mailto:', '').split('?')[0].trim())
    );
    
    // Better regex
    const pageEmails = html.match(/[a-zA-Z0-9._%+-]+@(?![0-9.])[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    
    const allEmails = [...new Set([...mailtoEmails, ...pageEmails].map(e => e.toLowerCase()))]
        .filter(e => e.includes('@') && e.includes('.') && !e.match(/\.(png|jpg|jpeg|gif|svg|webp|woff|ttf)$/i));

    if (allEmails.length > 0) {
        log.info(`Found ${allEmails.length} emails for ${businessName}`);
        await Dataset.pushData({ 
            businessName, 
            website, 
            emails: allEmails, 
            status: 'success',
            foundOn: request.url
        });
    } else if (pagesCrawled < maxWebsitePages) {
        log.info(`No emails on ${request.url}, looking for more pages...`);
        await enqueueLinks({
            limit: 5,
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
    } else {
        // Just log depth reached
        log.info(`Final depth reached for ${businessName} website.`);
    }
});

const crawler = new PlaywrightCrawler({
    requestHandler: router,
    maxConcurrency,
    requestHandlerTimeoutSecs: 90,
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--no-sandbox',
                '--disable-gpu',
            ],
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
    },
    preNavigationHooks: [
        async ({ blockRequests }) => {
            await blockRequests({
                urlPatterns: [
                    '.jpg', '.jpeg', '.png', '.svg', '.gif', '.css', '.woff', '.pdf', 
                    '.zip', 'google-analytics.com', 'facebook.net', 'googletagmanager.com'
                ],
            });
        },
    ],
});

crawleeLog.info('Starting crawler...');
await crawler.run(searchQueries.map(q => ({
    url: `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
    label: 'MAPS_SEARCH',
    userData: { query: q }
})));
crawleeLog.info('Crawler finished.');

await Actor.exit();
