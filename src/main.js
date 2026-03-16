import { Actor } from 'apify';
import { PlaywrightCrawler, CheerioCrawler, Dataset, createPlaywrightRouter, createCheerioRouter, log } from 'crawlee';

await Actor.init();

const { 
    searchQueries, 
    maxResultsPerQuery = 10, 
    maxWebsitePages = 2,
    maxConcurrency = 10 
} = await Actor.getInput();

const playwrightRouter = createPlaywrightRouter();
const cheerioRouter = createCheerioRouter();
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

playwrightRouter.addHandler('MAPS_SEARCH', async ({ page, request, enqueueLinks }) => {
    log.info(`Searching: ${request.userData.query}`);
    const cookieButton = await page.$('button[aria-label*="Accept"], button[aria-label*="Kabul"], button[id*="L2AGLb"]');
    if (cookieButton) await cookieButton.click();

    await page.waitForSelector('div[role="feed"]', { timeout: 15000 }).catch(() => {});
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

playwrightRouter.addHandler('BUSINESS_DETAIL', async ({ page, log }) => {
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

    const mapKey = name.toLowerCase().trim();
    if (!resultsMap.has(mapKey)) {
        resultsMap.set(mapKey, { businessName: name, website, emails: new Set(), status: 'processing' });
    } else {
        return;
    }

    if (website && !['facebook.com', 'instagram.com', 'twitter.com', 'linkedin.com', 'youtube.com', 'tiktok.com'].some(d => website.includes(d))) {
        // We will pass this to the Cheerio crawler later
    } else {
        resultsMap.get(mapKey).status = website ? 'skipped (social/google)' : 'no website';
    }
});

// CHEERIO HANDLER (Lightning fast)
cheerioRouter.addHandler('EXTRACT_EMAILS', async ({ $, request, log, enqueueLinks }) => {
    const { businessName, website, pagesCrawled } = request.userData;
    const mapKey = businessName.toLowerCase().trim();
    const res = resultsMap.get(mapKey);

    const html = $.html();
    const mailto = $('a[href^="mailto:"]').map((i, el) => $(el).attr('href').replace('mailto:', '').split('?')[0].trim()).get();
    const pageEmails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    
    if (res) {
        [...mailto, ...pageEmails].forEach(e => {
            const clean = e.toLowerCase().trim();
            if (clean.includes('@') && clean.includes('.') && !clean.match(/\.(png|jpg|jpeg|gif|svg|webp|woff|ttf|css|js|ico)$/)) {
                res.emails.add(clean);
            }
        });
    }

    if (!(res && res.emails.size > 0) && pagesCrawled < maxWebsitePages) {
        await enqueueLinks({
            limit: 3,
            label: 'EXTRACT_EMAILS',
            userData: { ...request.userData, pagesCrawled: pagesCrawled + 1 },
            transformRequestFunction: (req) => {
                const u = new URL(req.url);
                const b = new URL(website);
                if (u.hostname.replace('www.', '') !== b.hostname.replace('www.', '')) return false;
                if (/\.(pdf|zip|jpg|png|jpeg|docx?|xlsx?|woff2?|ttf|svg|css|js|mp4|mp3|wav)$/i.test(u.pathname)) return false;
                if (['login', 'cart', 'checkout', 'account', 'register'].some(w => u.pathname.toLowerCase().includes(w))) return false;
                return req;
            }
        });
    }

    if (res) {
        if (res.emails.size > 0) res.status = 'success';
        else if (res.status === 'processing') res.status = 'no emails found';
    }
});

// RUNNERS
log.info('Phase 1: Capturing businesses with Playwright...');
const playwrightCrawler = new PlaywrightCrawler({
    requestHandler: playwrightRouter,
    maxConcurrency: 2, // Maps is heavy, keep it low to save CPU for later
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--blink-settings=imagesEnabled=false'],
        },
    },
});

await playwrightCrawler.run(searchQueries.map(q => ({
    url: `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
    label: 'MAPS_SEARCH',
    userData: { query: q }
})));

log.info('Phase 2: Extracting emails with Cheerio (Fast Mode)...');
const websiteRequests = [];
for (const [key, data] of resultsMap.entries()) {
    if (data.website && data.status === 'processing') {
        websiteRequests.push({
            url: data.website,
            label: 'EXTRACT_EMAILS',
            userData: { businessName: data.businessName, website: data.website, pagesCrawled: 0 }
        });
    }
}

if (websiteRequests.length > 0) {
    const cheerioCrawler = new CheerioCrawler({
        requestHandler: cheerioRouter,
        maxConcurrency: 20, // Cheerio is very light, high concurrency is fine
    });
    await cheerioCrawler.run(websiteRequests);
}

log.info('Finalizing results...');
const finalResults = [];
for (const [name, data] of resultsMap.entries()) {
    finalResults.push({
        businessName: data.businessName,
        website: data.website,
        emails: [...data.emails],
        status: data.emails.size > 0 ? 'success' : data.status
    });
}
await Dataset.pushData(finalResults);
log.info(`Done. Pushed ${finalResults.length} businesses.`);

await Actor.exit();
