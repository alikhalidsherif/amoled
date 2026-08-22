// .amo v1 parser entry point (PLAN.md §Phase 2).
//
// parseAmo(text | object, baseUrl, engineDefaults?) →
//   { definition, warnings[] }  or throws AmoError

import { validateAndNormalize, AmoError } from "./validator.js";
import { DISPLAY_DEFAULTS } from "./defaults.js";

export { AmoError };

/**
 * @param {string|object} source - .amo JSON text or an already-parsed object.
 * @param {string} [baseUrl] - base URL for resolving relative asset paths.
 */
export function parseAmo(source, baseUrl) {
    let raw;
    if (typeof source === "string") {
        try {
            raw = JSON.parse(source);
        } catch (e) {
            throw new AmoError("", `invalid JSON: ${e.message}`);
        }
    } else if (source && typeof source === "object") {
        raw = source;
    } else {
        throw new AmoError("", "scene must be a JSON string or object");
    }

    const { definition, warnings } = validateAndNormalize(raw, baseUrl);
    return Object.freeze({ definition: Object.freeze(definition), warnings: Object.freeze(warnings) });
}
