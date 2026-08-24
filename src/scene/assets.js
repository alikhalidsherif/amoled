// Asset resolution/loading/caching (PLAN.md §Phase 3/4).
//
// `decoderFactory` is injected by the player (DOM-aware side): it knows how
// to create GIF/video decoder handles. This module stays DOM-free.

/**
 * @param {object} definition - normalized SceneDefinition (assets resolved).
 * @param {object} [cache] - optional Map shared across loads (URL -> decoded).
 * @param {object} [decoderFactory] - { gif(url), video(url) } → decoder handles.
 * @returns {Promise<object>} name -> decoded asset.
 */
export async function loadAssets(definition, cache, decoderFactory) {
    const store = cache || new Map();
    const out = {};

    for (const name of Object.keys(definition.assets)) {
        const url = definition.assets[name];

        if (store.has(url)) {
            out[name] = store.get(url);
            continue;
        }

        const sceneUses = collectAssetUses(definition.scene, name);
        if (sceneUses.length === 0) continue; // declared but unused

        let decoded;
        if (/\.gif($|\?)/i.test(url)) {
            if (!decoderFactory) throw new Error(`asset "${name}": GIF needs a decoderFactory`);
            decoded = await decoderFactory.gif(url);
        } else if (/(\.mp4|\.webm|\.mov)($|\?)/i.test(url)) {
            if (!decoderFactory) throw new Error(`asset "${name}": video needs a decoderFactory`);
            decoded = await decoderFactory.video(url);
        } else {
            decoded = await decodeImage(url);
        }

        store.set(url, decoded);
        out[name] = decoded;
    }

    return out;
}

function collectAssetUses(scene, name) {
    if (!scene || typeof scene !== "object") return [];
    if (scene.type === "composite" && Array.isArray(scene.layers)) {
        // Phase 6: walk layers
        return scene.layers.filter(l => l && l.asset === name);
    }
    return scene.asset === name ? [scene] : [];
}

/**
 * Decode a static image via an <img> element (works over file:// where
 * fetch() is blocked), converting to an ImageBitmap when supported.
 */
function decodeImage(url) {
    if (typeof Image === "undefined") {
        // Non-browser environment (unit tests): plain fetch path.
        return fetch(url)
            .then(r => { if (!r.ok) throw new Error(`failed to load image ${url} (${r.status})`); return r.blob(); })
            .then(b => createImageBitmap(b));
    }
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = async () => {
            try {
                if (typeof createImageBitmap === "function") {
                    resolve(await createImageBitmap(img));
                } else {
                    resolve(img);
                }
            } catch (e) {
                resolve(img);   // bitmap conversion failed; element still drawable
            }
        };
        img.onerror = () =>
            reject(new Error(`failed to load image ${url}` +
                (location.protocol === "file:"
                    ? " (opening scenes from disk limits media; serve via a local server for GIF/video)"
                    : "")));
        img.src = url;
    });
}
