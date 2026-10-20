// SEO & social-preview guarantees (docs/PLAN_UI_UX_OVERHAUL.md §10):
// every page ships a unique title/description, canonical, full Open Graph
// and Twitter card sets, and parseable JSON-LD; robots.txt + sitemap.xml
// exist and reference all three URLs; the shared OG image is 1200x630.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
function ok(cond, name) {
    if (cond) { passed++; }
    else { failed++; console.log("FAIL:", name); }
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

function meta(html, attr, name) {
    const re = new RegExp(
        `<meta\\s+[^>]*${attr}="${name.replace(/[:.]/g, "\\$&")}"[^>]*content="([^"]*)"`,
        "i"
    );
    const m = re.exec(html);
    if (m) return m[1];
    // content before attribute (rare ordering)
    const re2 = new RegExp(
        `<meta\\s+[^>]*content="([^"]*)"[^>]*${attr}="${name.replace(/[:.]/g, "\\$&")}"`,
        "i"
    );
    const m2 = re2.exec(html);
    return m2 ? m2[1] : null;
}

function tag(html, re) {
    const m = re.exec(html);
    if (!m) return null;
    return (m[1] !== undefined ? m[1] : m[0]).trim();
}

function jsonLdBlocks(html) {
    const out = [];
    const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) {
        try { out.push(JSON.parse(m[1])); }
        catch (e) { out.push({ __parseError: e.message }); }
    }
    return out;
}

function ldGraph(blocks) {
    return blocks.flatMap(b => (b && b["@graph"]) || (b ? [b] : []));
}

// --- PNG IHDR ---
function pngSize(rel) {
    const b = fs.readFileSync(path.join(ROOT, rel));
    if (b.length < 24 || b.toString("ascii", 1, 4) !== "PNG") return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const PAGES = [
    { rel: "index.html", url: "https://px.ali.et/" },
    { rel: "sim/index.html", url: "https://px.ali.et/sim/" },
    { rel: "guide/index.html", url: "https://px.ali.et/guide/" },
    { rel: "gen/index.html", url: "https://px.ali.et/gen/" }
];

// Pages that must answer searcher questions directly (FAQPage schema).
const FAQ_PAGES = ["index.html", "guide/index.html"];

const titles = [];
const htmls = {};

for (const p of PAGES) {
    const html = read(p.rel);
    htmls[p.rel] = html;

    const title = tag(html, /<title>([^<]*)<\/title>/i);
    titles.push(title);
    ok(title && title.length >= 10 && title.length <= 65,
        `${p.rel}: title present, 10..65 chars (got ${title && title.length}: ${title})`);
    ok(/px\.ali\.et/.test(title || ""), `${p.rel}: title carries the px.ali.et brand`);

    const desc = meta(html, "name", "description");
    ok(desc && desc.length >= 70 && desc.length <= 170,
        `${p.rel}: meta description 70..170 chars (got ${desc && desc.length})`);

    ok(/<html[^>]*lang="en"/i.test(html), `${p.rel}: html lang="en"`);
    ok(meta(html, "name", "viewport"), `${p.rel}: viewport meta`);
    ok(meta(html, "name", "theme-color"), `${p.rel}: theme-color meta`);
    ok(meta(html, "name", "color-scheme"), `${p.rel}: color-scheme meta`);
    ok(meta(html, "name", "robots")?.includes("index"), `${p.rel}: robots meta allows indexing`);
    ok(meta(html, "name", "author"), `${p.rel}: author meta`);

    const canonical = tag(html, /<link rel="canonical" href="([^"]+)"/i);
    ok(canonical === p.url, `${p.rel}: canonical is ${p.url} (got ${canonical})`);

    ok(tag(html, /<link rel="manifest"[^>]*>/i), `${p.rel}: manifest link`);
    ok(tag(html, /<link rel="icon"[^>]*>/i), `${p.rel}: favicon link`);

    // Open Graph
    ok(meta(html, "property", "og:type") === "website", `${p.rel}: og:type`);
    ok(meta(html, "property", "og:site_name") === "px.ali.et", `${p.rel}: og:site_name`);
    ok(meta(html, "property", "og:locale") === "en_US", `${p.rel}: og:locale`);
    ok(meta(html, "property", "og:url") === p.url, `${p.rel}: og:url matches canonical`);
    const ogTitle = meta(html, "property", "og:title");
    ok(ogTitle && ogTitle.length >= 10 && ogLengthOk(ogTitle), `${p.rel}: og:title present (${ogTitle})`);
    ok(meta(html, "property", "og:description"), `${p.rel}: og:description`);
    ok(meta(html, "property", "og:image") === "https://px.ali.et/assets/icons/og-preview.png",
        `${p.rel}: og:image absolute URL`);
    ok(meta(html, "property", "og:image:width") === "1200", `${p.rel}: og:image:width 1200`);
    ok(meta(html, "property", "og:image:height") === "630", `${p.rel}: og:image:height 630`);
    ok(meta(html, "property", "og:image:alt"), `${p.rel}: og:image:alt`);

    // Twitter
    ok(meta(html, "name", "twitter:card") === "summary_large_image", `${p.rel}: twitter:card`);
    ok(meta(html, "name", "twitter:title"), `${p.rel}: twitter:title`);
    ok(meta(html, "name", "twitter:description"), `${p.rel}: twitter:description`);
    ok(meta(html, "name", "twitter:image"), `${p.rel}: twitter:image`);

    // JSON-LD parses and carries at least one well-known type
    const blocks = jsonLdBlocks(html);
    ok(blocks.length >= 1, `${p.rel}: JSON-LD block present`);
    ok(blocks.every(b => !b.__parseError), `${p.rel}: JSON-LD parses as JSON`);
    const graph = ldGraph(blocks);
    const types = graph.map(n => n["@type"]);
    ok(types.some(t => ["WebSite", "SoftwareApplication", "WebApplication", "WebPage"].includes(t)),
        `${p.rel}: JSON-LD has an entry type (got ${types.join(",")})`);
    ok(graph.every(n => n.name || n.itemListElement), `${p.rel}: JSON-LD nodes are labeled`);

    // FAQPage schema on the content-heavy pages — mirrors the visible
    // <details> FAQ blocks so rich results have matching on-page content.
    if (FAQ_PAGES.includes(p.rel)) {
        const faq = graph.find(n => n["@type"] === "FAQPage");
        ok(!!faq, `${p.rel}: JSON-LD has a FAQPage node`);
        const questions = (faq && faq.mainEntity) || [];
        ok(questions.length >= 4, `${p.rel}: FAQPage has >= 4 questions (got ${questions.length})`);
        ok(questions.every(q => q["@type"] === "Question" && q.name && q.acceptedAnswer?.text),
            `${p.rel}: every FAQ Question has a name and answered text`);
        // Questions must exist as crawlable on-page copy too, not only in JSON-LD.
        const summaries = [...html.matchAll(/<summary>([^<]*)<\/summary>/g)].map(m => m[1].trim());
        ok(questions.every(q => summaries.some(s => s.includes(q.name.slice(0, 24)))),
            `${p.rel}: FAQ questions appear in visible <summary> copy`);
    }

    // Heading structure: exactly one h1 (visible or sr-only)
    const h1s = html.match(/<h1[\s>]/gi) || [];
    ok(h1s.length === 1, `${p.rel}: exactly one <h1> (got ${h1s.length})`);
}

// Titles must be unique across pages (no cannibalization).
ok(new Set(titles).size === titles.length,
    `titles are unique across pages (${JSON.stringify(titles)})`);

// --- OG image ---
const og = pngSize("assets/icons/og-preview.png");
ok(og && og.w === 1200 && og.h === 630,
    `og-preview.png is 1200x630 (got ${og && og.w + "x" && (og.w + "x" + og.h)})`);

// --- robots.txt / sitemap.xml ---
const robots = read("robots.txt");
ok(/^User-agent: \*$/m.test(robots), "robots.txt: wildcard user-agent");
ok(/^Allow: \/$/m.test(robots), "robots.txt: allows crawling");
ok(/Sitemap: https:\/\/px\.ali\.et\/sitemap\.xml/.test(robots), "robots.txt: points at sitemap");

const sitemap = read("sitemap.xml");
ok(sitemap.startsWith("<?xml"), "sitemap.xml: XML prolog");
for (const p of PAGES) {
    ok(sitemap.includes(`<loc>${p.url}</loc>`), `sitemap.xml: contains ${p.url}`);
}
const locCount = (sitemap.match(/<loc>/g) || []).length;
ok(locCount === PAGES.length, `sitemap.xml: exactly ${PAGES.length} URLs (got ${locCount})`);

// --- manifest brand ---
const manifest = JSON.parse(read("assets/icons/manifest.json"));
ok(manifest.name && /px\.ali\.et/.test(manifest.name), "manifest: name carries brand");
ok(manifest.short_name && manifest.short_name.length <= 12, "manifest: short_name <= 12 chars");
ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "manifest: icons listed");

function ogLengthOk(s) { return s.length >= 10 && s.length <= 70; }

if (failed) {
    console.log(`\nSEO: ${failed} FAILURES (${passed} passed)`);
    process.exit(1);
} else {
    console.log(`SEO: ${passed} checks passed`);
}
