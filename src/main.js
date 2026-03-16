import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter, log as crawleeLog } from 'crawlee';

await Actor.init();

const { 
    searchQueries, 
    maxResultsPerQuery = 10, 
    maxWebsitePages = 2,
    maxConcurrency = 5 
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
        const el = document.querySelector('a[data-item-id="authority"]') || document.querySelector('a[aria-label*="website"]');
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

router.addHandler('EXTRACT_EMAILS', async ({ page, request, enqueueLinks }) => {
    const { businessName, website, pagesCrawled } = request.userData;
    crawleeLog.info(`Crawling website: ${request.url} (Deep: ${pagesCrawled})`);

    const html = await page.content();
    const emails = [...new Set(html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(?!jpeg|jpg|png|gif|webp|svg|ico|css|js|woff2?|ttf)[a-zA-Z]{2,}/g) || [])];

    if (emails.length > 0) {
        crawleeLog.info(`Found ${emails.length} emails for ${businessName}`);
        await Dataset.pushData({ 
            businessName, 
            website, 
            emails: emails.map(e => e.toLowerCase()), 
            status: 'success',
            foundOn: request.url
        });
    } else if (pagesCrawled < maxWebsitePages) {
        await enqueueLinks({
            limit: 3,
            selector: 'a',
            label: 'EXTRACT_EMAILS',
            userData: { ...request.userData, pagesCrawled: pagesCrawled + 1 },
            transformRequestFunction: (req) => {
                try {
                    const u = new URL(req.url);
                    const b = new URL(website);
                    if (u.hostname.replace('www.', '') === b.hostname.replace('www.', '') && !/\.(pdf|zip|jpg|png|jpeg|docx?|xlsx?|woff2?|ttf|svg)$/i.test(u.pathname)) return req;
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
    // Increase timeout for Istanbul's large results if needed
    requestHandlerTimeoutSecs: 60,
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },
    // Speed up by blocking non-essential assets
    preNavigationHooks: [
        async ({ blockRequests }) => {
            await blockRequests({
                urlPatterns: ['.jpg', '.jpeg', '.png', '.svg', '.gif', '.css', '.woff', '.pdf', '.zip'],
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
