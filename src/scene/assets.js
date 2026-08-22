// Asset resolution/loading/caching (PLAN.md §Phase 3).
// v1: images only (ImageBitmap). GIF/video scene types are rejected with a
// clear message until Phase 4 wires the runtime clock to their decoders.

/**
 * @param {object} definition - normalized SceneDefinition (assets resolved).
 * @param {object} [cache] - optional Map shared across loads (URL -> decoded).
 * @returns {Promise<object>} name -> decoded asset.
 */
export async function loadAssets(definition, cache) {
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

        if (/\.gif($|\?)/i.test(url)) {
            throw new Error(`asset "${name}": GIF scenes arrive in Phase 4`);
        }
        if (/(\.mp4|\.webm|\.mov)($|\?)/i.test(url)) {
            throw new Error(`asset "${name}": video scenes arrive in Phase 4`);
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`asset "${name}": failed to load ${url} (${response.status})`);
        }
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        store.set(url, bitmap);
        out[name] = bitmap;
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
