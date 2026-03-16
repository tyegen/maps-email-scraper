import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter, log as crawleeLog } from 'crawlee';

await Actor.init();

const { 
    searchQueries, 
    maxResultsPerQuery = 10, 
    maxWebsitePages = 2,
    maxConcurrency = 2 // Lowered default to prevent OOM on 1GB
} = await Actor.getInput();

const router = createPlaywrightRouter();
const requestQueue = await Actor.openRequestQueue();

router.addHandler('MAPS_SEARCH', async ({ page, request, enqueueLinks }) => {
    crawleeLog.info(`Searching Google Maps for: ${request.userData.query}`);
    
    // Cookie consent
    const cookieButton = await page.$('button[aria-label*="Accept"], button[aria-label*="Kabul"]');
    if (cookieButton) {
        await cookieButton.click();
        await page.waitForTimeout(2000);
    }

    await page.waitForSelector('div[role="feed"]', { timeout: 30000 }).catch(() => crawleeLog.error('Feed not found'));
    
    // Scroll
    await page.evaluate(async (max) => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return;
        let lastHeight = feed.scrollHeight;
        let articles = document.querySelectorAll('div[role="article"]').length;
        while (articles < max) {
            feed.scrollBy(0, 1000);
            await new Promise(r => setTimeout(r, 2000));
            articles = document.querySelectorAll('div[role="article"]').length;
            if (feed.scrollHeight === lastHeight) break;
            lastHeight = feed.scrollHeight;
        }
    }, maxResultsPerQuery);

    const links = await page.$$eval('div[role="article"] a', (els) => {
        return els.filter(el => el.href && el.href.includes('/maps/place/')).map(el => el.href);
    });

    const uniqueLinks = [...new Set(links)].slice(0, maxResultsPerQuery);
    crawleeLog.info(`Found ${uniqueLinks.length} businesses to process.`);

    for (const url of uniqueLinks) {
        await enqueueLinks({
            urls: [url],
            label: 'BUSINESS_DETAIL',
            userData: { query: request.userData.query }
        });
    }
});

router.addHandler('BUSINESS_DETAIL', async ({ page, request, enqueueLinks }) => {
    crawleeLog.info(`Processing business detail: ${request.url}`);
    await page.waitForTimeout(3000);

    const name = await page.$eval('h1', el => el.innerText.trim()).catch(() => 'Unknown');
    const website = await page.evaluate(() => {
        const el = document.querySelector('a[data-item-id="authority"]') 
                || document.querySelector('a[aria-label*="website"]')
                || document.querySelector('a[aria-label*="Web sitesi"]')
                || document.querySelector('a[aria-label*="web sitesi"]');
        return el ? el.href : null;
    });

    crawleeLog.info(`Business: ${name}, Website: ${website || 'N/A'}`);

    if (website && !['google.com', 'gstatic.com', 'facebook.com', 'instagram.com', 'twitter.com', 'linkedin.com'].some(d => website.includes(d))) {
        crawleeLog.info(`Enqueuing website for email extraction: ${website}`);
        // Use requestQueue directly for more reliability in handler transitions
        await requestQueue.addRequest({
            url: website,
            label: 'EXTRACT_EMAILS',
            userData: { businessName: name, website: website, pagesCrawled: 0 },
            // Unique key to prevent duplicate processing of the same website
            uniqueKey: website.replace('www.', '').split(/[?#]/)[0]
        });
    } else {
        crawleeLog.info(`Skipping website for ${name}: ${website || 'None'}`);
        await Dataset.pushData({ businessName: name, website, emails: [], status: website ? 'skipped domain' : 'no website' });
    }
});

router.addHandler('EXTRACT_EMAILS', async ({ page, request, log, enqueueLinks }) => {
    const { businessName, website, pagesCrawled } = request.userData;
    log.info(`Crawling website: ${request.url} (Depth: ${pagesCrawled})`);

    const html = await page.content();
    const mailtoEmails = await page.$$eval('a[href^="mailto:"]', (els) => 
        els.map(el => el.href.replace('mailto:', '').split('?')[0].trim())
    );
    
    const pageEmails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(?!jpeg|jpg|png|gif|webp|svg|ico|css|js|woff2?|ttf|svg)[a-zA-Z]{2,}/g) || [];
    
    const allEmails = [...new Set([...mailtoEmails, ...pageEmails].map(e => e.toLowerCase()))]
        .filter(e => e.includes('@') && e.includes('.') && !e.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i));

    if (allEmails.length > 0) {
        log.info(`Found ${allEmails.length} emails for ${businessName}: ${allEmails[0]}...`);
        await Dataset.pushData({ 
            businessName, 
            website, 
            emails: allEmails, 
            status: 'success',
            foundOn: request.url
        });
    } else if (pagesCrawled < maxWebsitePages) {
        log.info(`No emails found on ${request.url}, looking for more pages...`);
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
                    
                    // Prioritize contact/about pages specially in the first level
                    const p = u.pathname.toLowerCase();
                    const words = ['contact', 'iletisim', 'about', 'hakkimizda', 'bize-ulasin', 'contact-us', 'iletisim-bilgileri'];
                    if (pagesCrawled === 0 && !words.some(w => p.includes(w)) && !p.endsWith('/') && p.length > 1) {
                        // We still allow it but the limit 5 handles the growth
                    }
                    return req;
                } catch(e) {}
                return false;
            }
        });
    } else {
        await Dataset.pushData({ businessName, website, emails: [], status: 'no emails found' });
    }
});

const crawler = new PlaywrightCrawler({
    requestHandler: router,
    maxConcurrency,
    requestHandlerTimeoutSecs: 60,
    launchContext: {
        launchOptions: {
            headless: true,
            // Add flags to reduce memory footprint
            args: [
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--no-sandbox',
                '--disable-gpu',
            ],
        },
    },
    // Recycle browser instances more frequently to free memory
    browserPoolOptions: {
        maxRequestsPerBrowser: 10,
    },
    preNavigationHooks: [
        async ({ blockRequests }) => {
            await blockRequests({
                // Block more aggressively
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
