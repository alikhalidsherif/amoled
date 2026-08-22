// Tiny Map-based caches: parsed scenes, decoded assets, rendered frames.

export function createCacheStore() {
    const sceneCache = new Map();   // url -> { definition, warnings }
    const assetCache = new Map();   // url -> decoded asset
    const frameCache = new Map();   // cacheKey -> Uint8ClampedArray

    return {
        sceneCache,
        assetCache,
        frameCache,

        getScene(url) {
            return sceneCache.get(url);
        },
        putScene(url, parsed) {
            sceneCache.set(url, parsed);
            return parsed;
        },

        getAsset(url) {
            return assetCache.get(url);
        },
        putAsset(url, decoded) {
            assetCache.set(url, decoded);
            return decoded;
        },

        // Static-frame reuse keyed by everything that changes raster output.
        frameKey(definition, w, h) {
            return `${definition.meta.name}:${w}x${h}:${stableHash(definition)}`;
        },
        getFrame(key) {
            return frameCache.get(key);
        },
        putFrame(key, buffer) {
            // Bound the cache; static scenes are small (<= 1280*720*3).
            if (frameCache.size > 8) {
                frameCache.delete(frameCache.keys().next().value);
            }
            frameCache.set(key, buffer);
            return buffer;
        },

        clear() {
            sceneCache.clear();
            assetCache.clear();
            frameCache.clear();
        }
    };
}

// Deterministic JSON hash (FNV-1a over stable stringify). Good enough for
// cache keys — NOT for security.
function stableHash(value) {
    return fnv1a(stableStringify(value));
}

function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}
