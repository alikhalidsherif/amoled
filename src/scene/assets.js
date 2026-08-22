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
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`asset "${name}": failed to load ${url} (${response.status})`);
            }
            const blob = await response.blob();
            decoded = await createImageBitmap(blob);
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
