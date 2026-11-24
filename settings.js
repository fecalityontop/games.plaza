// Shared tab-cloak handling for the home, game, and settings pages.
(function () {
    const STORAGE_KEY = "gpSettings";
    const DEFAULT_CLOAK = "google";

    function readSettings() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
        } catch (e) {
            return {};
        }
    }

    function cloakValue() {
        const value = readSettings().cloak;
        return value === "none" || value === "google" || value === "focus"
            ? value
            : DEFAULT_CLOAK;
    }

    function applyCloak(value) {
        const favi = document.querySelector("link[rel*='icon']");
        if (!favi) return;
        if (value === "none") {
            favi.href = "favicon.ico";
            document.title = "games.plaza";
        } else if (value === "focus") {
            favi.href = "favicon3.ico";
            document.title = "Portal";
        } else {
            favi.href = "favicon2.ico";
            document.title = "Google";
        }
    }

    function setCloak(value) {
        const settings = readSettings();
        settings.cloak = value;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        applyCloak(value);
    }

    window.setCloak = setCloak;

    const select = document.getElementById("set-cloak");
    if (select) {
        select.value = cloakValue();
        applyCloak(select.value);
        select.addEventListener("change", function (event) {
            setCloak(event.target.value);
        });
    } else {
        applyCloak(cloakValue());
    }
})();
