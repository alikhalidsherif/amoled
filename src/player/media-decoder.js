// Media decoder factory (PLAN.md §Phase 4).
//
// Wraps the legacy ClientMediaLoader classic-script global as pure decoders
// for the scene runtime: the runtime drives frames via getFrame() on its own
// clock — the loader's internal setInterval loop is never used here.
// This module is DOM-aware by design (src/player/** may use DOM).

export function createMediaDecoderFactory() {
    const CML = globalThis.AMOLED && globalThis.AMOLED.ClientMediaLoader;
    if (!CML) {
        throw new Error("ClientMediaLoader unavailable; GIF/video scenes disabled.");
    }

    return {
        async gif(url) {
            const loader = new CML();
            await loader.load(url);
            return {
                type: "gif",
                advance: () => loader.advance(),
                getFrame: (w, h) => loader.getFrame(w, h),
                pause() { /* gif advancement is tick-driven */ },
                play() { /* ditto */ },
                destroy() { loader.stop(); }
            };
        },

        async video(url) {
            const loader = new CML();
            await loader.load(url);
            const element = loader.getElement();
            element.muted = true;
            element.loop = true;
            return {
                type: "video",
                advance() { /* video advances itself when playing */ },
                getFrame: (w, h) => loader.getFrame(w, h),
                play() {
                    const p = element.play();
                    if (p && p.catch) p.catch(() => { /* autoplay policies */ });
                },
                pause() { element.pause(); },
                destroy() { loader.stop(); }
            };
        }
    };
}
