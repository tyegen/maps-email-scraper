import { Actor } from 'apify';
import { PlaywrightCrawler, CheerioCrawler, Dataset, createPlaywrightRouter, createCheerioRouter, log } from 'crawlee';

await Actor.init();

const { 
    searchQueries, 
    maxResultsPerQuery = 10, 
    maxWebsitePages = 2,
    maxConcurrency = 10,
    extractPlaceDetails = false,
    extractContacts = false,
    extractSocialMedia = false
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

    const items = await page.$$eval('div[role="article"]', (articles) => {
        return articles.map(article => {
            const linkEl = article.querySelector('a[href*="/maps/place/"]');
            if (!linkEl) return null;
            
            const mapsUrl = linkEl.href;
            const businessName = linkEl.getAttribute('aria-label') || 'Unknown';
            
            // Try to find website button in the feed card
            let website = null;
            const webEls = article.querySelectorAll('a');
            for (const a of webEls) {
                if (a.href && !a.href.includes('google.com') && !a.href.includes('/maps/') && (a.innerText.toLowerCase().includes('site') || a.innerText.toLowerCase().includes('web') || a.getAttribute('data-value')?.toLowerCase().includes('web'))) {
                    website = a.href;
                    break;
                }
            }
            
            return { mapsUrl, businessName, website };
        }).filter(item => item !== null);
    });

    // Deduplicate from feed
    const uniqueItems = [];
    const seen = new Set();
    for (const item of items) {
        if (!seen.has(item.mapsUrl)) {
            seen.add(item.mapsUrl);
            uniqueItems.push(item);
        }
    }
    const limitedItems = uniqueItems.slice(0, maxResultsPerQuery);
    
    log.info(`Found ${limitedItems.length} businesses.`);

    for (const item of limitedItems) {
        const mapKey = item.businessName.toLowerCase().trim();
        if (!resultsMap.has(mapKey)) {
            resultsMap.set(mapKey, { 
                businessName: item.businessName, 
                mapsUrl: item.mapsUrl,
                website: cleanWebsiteUrl(item.website), 
                emails: new Set(),
                socials: {},
                status: 'feed_extracted' 
            });
        }
        
        if (extractPlaceDetails) {
            await enqueueLinks({
                urls: [item.mapsUrl],
                label: 'BUSINESS_DETAIL',
                userData: { query: request.userData.query, mapKey, businessName: item.businessName }
            });
        }
    }
});

playwrightRouter.addHandler('BUSINESS_DETAIL', async ({ page, request, log }) => {
    const { mapKey, businessName } = request.userData;
    
    await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});
    
    // Extract deep details
    const details = await page.evaluate(() => {
        const d = { 
            category: null, address: null, phone: null, 
            totalScore: null, reviewsCount: null, price: null 
        };
        
        const catEl = document.querySelector('button[jsaction*="category"]');
        if (catEl) d.category = catEl.innerText.trim();
        
        const addrEl = document.querySelector('button[data-item-id="address"]');
        if (addrEl) d.address = addrEl.innerText.trim();
        
        const phoneEl = document.querySelector('button[data-item-id^="phone:"]');
        if (phoneEl) d.phone = phoneEl.innerText.trim();
        
        const scoreEl = document.querySelector('div[role="img"][aria-label*="stars"]');
        if (scoreEl) {
            const match = scoreEl.getAttribute('aria-label').match(/[\d,.]+/g);
            if (match && match.length >= 2) {
                d.totalScore = parseFloat(match[0].replace(',', '.'));
                d.reviewsCount = parseInt(match[1].replace(/\D/g, ''), 10);
            }
        }
        
        return d;
    });

    // Check if we didn't find website in feed, try to find it here
    let website = await page.evaluate(() => {
        const el = document.querySelector('a[data-item-id="authority"]') || document.querySelector('a[aria-label*="website"]');
        return el ? el.href : null;
    });

    log.info(`Extracted Details for: ${businessName}`);

    const res = resultsMap.get(mapKey);
    if (res) {
        Object.assign(res, details);
        if (!res.website && website) {
            res.website = cleanWebsiteUrl(website);
        }
        res.status = 'details_extracted';
    }
});

// CHEERIO HANDLER (Lightning fast, for Contacts & Social Media)
cheerioRouter.addHandler('EXTRACT_EMAILS', async ({ $, request, log, enqueueLinks }) => {
    const { businessName, website, pagesCrawled } = request.userData;
    const mapKey = businessName.toLowerCase().trim();
    const res = resultsMap.get(mapKey);

    const html = $.html();
    
    if (res && extractContacts) {
        const mailto = $('a[href^="mailto:"]').map((i, el) => $(el).attr('href').replace('mailto:', '').split('?')[0].trim()).get();
        const pageEmails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        [...mailto, ...pageEmails].forEach(e => {
            const clean = e.toLowerCase().trim();
            if (clean.includes('@') && clean.includes('.') && !clean.match(/\.(png|jpg|jpeg|gif|svg|webp|woff|ttf|css|js|ico)$/)) {
                res.emails.add(clean);
            }
        });
    }

    if (res && extractSocialMedia) {
        const socialLinks = $('a').map((i, el) => $(el).attr('href')).get().filter(h => h && h.startsWith('http'));
        const platforms = ['facebook', 'instagram', 'twitter', 'linkedin', 'youtube', 'tiktok', 'pinterest'];
        
        for (const link of socialLinks) {
            for (const platform of platforms) {
                if (link.toLowerCase().includes(`${platform}.com`)) {
                    if (!res.socials[platform]) res.socials[platform] = new Set();
                    res.socials[platform].add(link);
                }
            }
        }
    }

    // Crawl deeper if needed
    if (!(res && res.emails.size > 0 && res.socials && Object.keys(res.socials).length > 0) && pagesCrawled < maxWebsitePages) {
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
        res.status = 'enriched';
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

if (extractContacts || extractSocialMedia) {
    log.info('Phase 2: Extracting Contacts & Socials with Cheerio (Fast Mode)...');
    const websiteRequests = [];
    for (const [key, data] of resultsMap.entries()) {
        if (data.website && !['facebook.com', 'instagram.com', 'twitter.com', 'linkedin.com', 'youtube.com', 'tiktok.com'].some(d => data.website.includes(d))) {
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
} else {
    log.info('Phase 2 skipped (extractContacts & extractSocialMedia are false).');
}

log.info('Finalizing results...');
const finalResults = [];
for (const [name, data] of resultsMap.entries()) {
    const finalData = {
        title: data.businessName,
        mapsUrl: data.mapsUrl,
        website: data.website,
        categoryName: data.category || null,
        address: data.address || null,
        phoneUnformatted: data.phone || null,
        totalScore: data.totalScore || null,
        reviewsCount: data.reviewsCount || null,
    };

    if (extractContacts) {
        finalData.emails = [...data.emails];
    }
    
    if (extractSocialMedia) {
        // Convert Sets in socials to arrays
        const socialsArrays = {};
        for (const [plat, links] of Object.entries(data.socials)) {
            socialsArrays[`${plat}s`] = [...links];
        }
        Object.assign(finalData, socialsArrays);
    }

    finalResults.push(finalData);
}
await Dataset.pushData(finalResults);
log.info(`Done. Pushed ${finalResults.length} businesses.`);

await Actor.exit();
