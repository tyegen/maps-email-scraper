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
            const businessName = article.getAttribute('aria-label') || linkEl.getAttribute('aria-label') || 'Unknown';
            
            // Try to find website button in the feed card
            let website = null;
            const webEls = article.querySelectorAll('a');
            for (const a of webEls) {
                // Explicitly check for website strings. Google sometimes uses google.com/url redirects here.
                if (a.href && !a.href.includes('/maps/') && (a.innerText.toLowerCase().includes('site') || a.innerText.toLowerCase().includes('web') || a.getAttribute('data-value')?.toLowerCase().includes('website'))) {
                    website = a.href;
                    break;
                }
            }
            
            // Extract Rating & Reviews robustly
            let totalScore = null;
            let reviewsCount = null;
            
            // Try explicit aria-label search first
            const imgSpans = Array.from(article.querySelectorAll('span[role="img"]'));
            for (const span of imgSpans) {
                const aria = span.getAttribute('aria-label') || '';
                // e.g. "4.8 stars" or "4,8 yıldızlı"
                if (aria.toLowerCase().includes('star') || aria.toLowerCase().includes('yıldız') || aria.toLowerCase().includes('review') || aria.toLowerCase().includes('yorum')) {
                    const match = aria.match(/[\d,.]+/g);
                    if (match && match.length > 0) {
                        totalScore = parseFloat(match[0].replace(',', '.'));
                        if (match.length >= 2) {
                            reviewsCount = parseInt(match[1].replace(/[^\d]/g, ''), 10);
                        }
                        break;
                    }
                }
            }

            // Fallback: look at the inner text of the entire article for a number and optional review count in parens
            if (totalScore === null) {
                const textContent = article.innerText || '';
                const match = textContent.match(/(\d[.,]\d)(\s*\(([\d.,]+)\))?/);
                if (match) {
                    totalScore = parseFloat(match[1].replace(',', '.'));
                    if (match[3]) {
                        reviewsCount = parseInt(match[3].replace(/[^\d]/g, ''), 10);
                    }
                }
            }

            // Extract Address safely, ignoring opening hours
            let address = null;
            let city = null;
            let country = null;

            const textDivs = article.querySelectorAll('div > div');
            for (const div of textDivs) {
                const text = div.innerText || '';
                // Look for lines with dots but explicitly avoid time strings
                if (text.includes('·') && !text.match(/\d{1,2}:\d{2}/) && !text.toLowerCase().match(/(açık|kapalı|open|closed)/)) {
                    const parts = text.split('·').map(p => p.trim());
                    const lastPart = parts[parts.length - 1];
                    if (lastPart && lastPart.length > 3 && !lastPart.includes('$') && !lastPart.toLowerCase().match(/(review|yorum)/)) {
                        address = lastPart;
                    }
                }
            }

            // Extract Coordinates from URL
            let location = { lat: null, lng: null };
            const coordsMatch = mapsUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
            if (coordsMatch) {
                location.lat = parseFloat(coordsMatch[1]);
                location.lng = parseFloat(coordsMatch[2]);
            }

            return { mapsUrl, businessName, website, totalScore, reviewsCount, address, city, country, location };
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
                totalScore: item.totalScore,
                reviewsCount: item.reviewsCount,
                address: item.address,
                city: item.city,
                country: item.country,
                location: item.location,
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
            totalScore: null, reviewsCount: null, price: null,
            city: null, country: null
        };
        
        const catEl = document.querySelector('button[jsaction*="category"]');
        if (catEl) d.category = catEl.innerText.trim();
        
        const addrEl = document.querySelector('button[data-item-id="address"]');
        if (addrEl) {
            const rawAddress = addrEl.innerText.trim();
            d.address = rawAddress;
            const parts = rawAddress.split(',').map(s => s.trim());
            if (parts.length >= 3) {
                d.country = parts[parts.length - 1]; // Assume last part is country
                d.city = parts[parts.length - 2].split(' ')[0]; // Basic split for city
            }
        }
        
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
const mapMarkers = [];

for (const [name, data] of resultsMap.entries()) {
    // Map to exactly what the user requested
    const finalData = {
        "place name": data.businessName,
        "total score": data.totalScore || null,
        "reviews count": data.reviewsCount || null,
        "street": data.address || null,
        "website": data.website
    };

    if (extractContacts) {
        finalData.emails = [...data.emails];
    }
    
    if (extractSocialMedia) {
        const socialsArrays = {};
        for (const [plat, links] of Object.entries(data.socials)) {
            socialsArrays[`${plat}s`] = [...links];
        }
        Object.assign(finalData, socialsArrays);
    }

    finalResults.push(finalData);

    // Prepare Map Markers (we still need location here for the map, but it won't be pushed to Dataset)
    if (data.location && data.location.lat && data.location.lng) {
        mapMarkers.push({
            lat: data.location.lat,
            lng: data.location.lng,
            title: finalData.title,
            score: finalData.totalScore
        });
    }
}
await Dataset.pushData(finalResults);

// Generate Live Map HTML
if (mapMarkers.length > 0) {
    log.info('Generating results-map.html...');
    const mapHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Google Maps Scraper - Live View</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <style>#map { height: 100vh; width: 100%; margin: 0; padding: 0; }</style>
    </head>
    <body style="margin:0;">
        <div id="map"></div>
        <script>
            const markers = ${JSON.stringify(mapMarkers)};
            const map = L.map('map');
            let bounds = new L.LatLngBounds();
            
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap'
            }).addTo(map);

            markers.forEach(m => {
                const marker = L.marker([m.lat, m.lng]).addTo(map);
                marker.bindPopup('<b>' + m.title + '</b><br>Rating: ' + (m.score || 'N/A'));
                bounds.extend([m.lat, m.lng]);
            });

            if (markers.length > 0) {
                map.fitBounds(bounds, { padding: [50, 50] });
            } else {
                map.setView([0, 0], 2);
            }
        </script>
    </body>
    </html>
    `;
    // Apify uses the 'OUTPUT' key to populate the Live View tab automatically.
    // If we save html there, the user doesn't need to host anything.
    await Actor.setValue('OUTPUT', mapHtml, { contentType: 'text/html' });
}

log.info(`Done. Pushed ${finalResults.length} businesses.`);

await Actor.exit();
