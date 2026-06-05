const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let turnstileLoadPromise = null;

export function loadTurnstile() {
    if (window.turnstile) {
        return Promise.resolve(window.turnstile);
    }

    if (turnstileLoadPromise) {
        return turnstileLoadPromise;
    }

    turnstileLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = TURNSTILE_SCRIPT_URL;
        script.async = true;
        script.defer = true;
        script.dataset.cloudMailTurnstile = 'true';
        script.onload = () => {
            if (window.turnstile) {
                resolve(window.turnstile);
            } else {
                reject(new Error('Turnstile not available'));
            }
        };
        script.onerror = () => {
            turnstileLoadPromise = null;
            reject(new Error('Turnstile script failed to load'));
        };
        document.head.appendChild(script);
    });

    return turnstileLoadPromise;
}
