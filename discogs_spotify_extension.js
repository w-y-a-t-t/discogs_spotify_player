// ==UserScript==
// @name         Discogs Spotify Extension
// @namespace    https://github.com/w-y-a-t-t/discogs_spotify_extension
// @version      1.0
// @description  Automatically embeds Spotify players on Discogs release and master pages
// @author       w-y-a-t-t
// @homepage     https://github.com/w-y-a-t-t/discogs_spotify_extension
// @supportURL   https://github.com/w-y-a-t-t/discogs_spotify_extension
// @match        https://www.discogs.com/master/*
// @match        https://www.discogs.com/release/*
// @match        https://www.discogs.com/*/master/*
// @match        https://www.discogs.com/*/release/*
// @match        https://www.discogs.com/callback*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @connect      api.spotify.com
// @connect      accounts.spotify.com
// @run-at       document-idle
// @inject-into  content
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        clientId: 'Your Spotify Client ID',
        spotifyApiBase: 'https://api.spotify.com/v1',
        authEndpoint: 'https://accounts.spotify.com/authorize',
        redirectUri: 'https://www.discogs.com/callback',
        tokenMaxAge: 24 * 60 * 60 * 1000, // 24 hours
        maxLoadWaitTime: 10000, // Increased to 10 seconds
        maxRetries: 3,
        retryDelay: 1000,
        initDebounceTime: 500 // Prevent multiple initializations within 500ms
    };

    // State management to prevent auth container flashing
    let authState = {
        isAuthenticating: false,
        authContainerVisible: false,
        loadingVisible: false,
        playerVisible: false,
        isInitializing: false,
        lastInitTime: 0
    };

    // Add styles
    const addStyles = () => {
        GM_addStyle(`
            .spotify-player-container {
                margin: 20px 0;
                padding: 15px;
                background: #f8f8f8;
                border-radius: 8px;
                max-width: 400px;
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            }
            .spotify-player-error {
                color: #e91e63;
                padding: 10px;
                margin: 10px 0;
                background: #fff;
                border: 1px solid #e91e63;
                border-radius: 4px;
                font-size: 14px;
            }
            .spotify-login-button {
                background: #1DB954;
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 20px;
                cursor: pointer;
                font-weight: bold;
                transition: background-color 0.3s ease;
            }
            .spotify-login-button:hover {
                background: #1ed760;
            }
            .spotify-auth-container {
                margin: 20px 0;
                padding: 15px;
                background: #f8f8f8;
                border-radius: 8px;
                max-width: 400px;
                text-align: center;
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            }
            .spotify-loading {
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }
            .spotify-loading-spinner {
                border: 3px solid #f3f3f3;
                border-top: 3px solid #1DB954;
                border-radius: 50%;
                width: 20px;
                height: 20px;
                animation: spin 1s linear infinite;
                margin-right: 10px;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `);
    };

    // Logging helpers
    const log = (...args) => console.log('[Discogs Spotify]', ...args);
    const logError = (message, error) => console.error('[Discogs Spotify Error]', message, error);

    // Sleep helper
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // String similarity function
    const similarity = (s1, s2) => {
        if (!s1 || !s2) return 0;
        s1 = s1.toLowerCase().replace(/\b(the|a|an|and|or|but|in|on|at|to|for|of|with|by)\b/gi, '').replace(/[^\w\s]/g, '').trim();
        s2 = s2.toLowerCase().replace(/\b(the|a|an|and|or|but|in|on|at|to|for|of|with|by)\b/gi, '').replace(/[^\w\s]/g, '').trim();
        if (s1 === s2) return 1.0;
        if (s1.length < 2 || s2.length < 2) return 0.0;
        if (s1.includes(s2) || s2.includes(s1)) return 0.8;
        const words1 = new Set(s1.split(/\s+/));
        const words2 = new Set(s2.split(/\s+/));
        const commonWords = [...words1].filter(word => words2.has(word) && word.length > 1);
        return commonWords.length / Math.max(words1.size, words2.size);
    };

    // Check if page is fully loaded with broader selectors
    const isPageFullyLoaded = () => {
        const titleElement = document.querySelector('h1') || document.querySelector('[class*="title"]');
        const artistElement = document.querySelector('h1 a') || document.querySelector('[class*="artist"] a');
        log('Checking page load:', { title: !!titleElement, artist: !!artistElement });
        return titleElement && artistElement;
    };

    // Wait for page to load with MutationObserver
    const waitForPageLoad = async () => {
        if (isPageFullyLoaded()) return true;

        return new Promise((resolve) => {
            const observer = new MutationObserver(() => {
                if (isPageFullyLoaded()) {
                    observer.disconnect();
                    resolve(true);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            setTimeout(() => {
                observer.disconnect();
                resolve(isPageFullyLoaded());
            }, CONFIG.maxLoadWaitTime);
        });
    };

    // Extract album info
    const extractAlbumInfo = () => {
        const titleElement = document.querySelector('h1') || document.querySelector('[class*="title"]');
        const artistElement = document.querySelector('h1 a') || document.querySelector('[class*="artist"] a');

        if (!titleElement || !artistElement) {
            logError('Missing title or artist elements', { title: !!titleElement, artist: !!artistElement });
            return null;
        }

        let title = titleElement.textContent.trim();
        let artist = artistElement.textContent.trim();

        artist = artist.replace(/[\(\[]\d+[\)\]]/g, '').trim();
        if (title.includes(artist)) title = title.replace(artist, '').trim();
        title = title.replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '').replace(/\s*\([^)]+\)\s*$/g, '').replace(/\s*\[[^\]]+\]\s*/g, '').trim();

        log('Extracted:', { title, artist });
        return { title, artist };
    };

    // Find injection point
    const findInjectionPoint = () => {
        const selectors = [
            'h1', '.profile_header', '.profile', '.body', 'main', '#page', 'body'
        ];
        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element) {
                log('Injection point:', selector);
                return element;
            }
        }
        logError('No injection point found');
        return document.body;
    };

    // Show loading indicator
    const showLoadingIndicator = () => {
        // Don't remove auth container if we're in auth process
        if (!authState.isAuthenticating) {
            document.querySelectorAll('.spotify-player-container, .spotify-auth-container').forEach(el => el.remove());
            authState.authContainerVisible = false;
        } else {
            // Only remove player containers, not auth containers
            document.querySelectorAll('.spotify-player-container').forEach(el => el.remove());
        }
        
        // Only show loading if not already visible
        if (!authState.loadingVisible) {
            authState.loadingVisible = true;
            authState.playerVisible = false;
            
            const container = document.createElement('div');
            container.className = 'spotify-player-container';
            container.innerHTML = `<div class="spotify-loading"><div class="spotify-loading-spinner"></div><span>Searching Spotify...</span></div>`;
            findInjectionPoint().insertBefore(container, findInjectionPoint().firstChild);
        }
    };

    // Inject player
    const injectPlayer = (albumId) => {
        // Don't remove auth container if we're in auth process
        if (!authState.isAuthenticating) {
            document.querySelectorAll('.spotify-player-container, .spotify-auth-container').forEach(el => el.remove());
            authState.authContainerVisible = false;
        } else {
            // Only remove existing player/loading containers, not auth containers
            document.querySelectorAll('.spotify-player-container').forEach(el => el.remove());
        }
        
        authState.loadingVisible = false;
        authState.playerVisible = true;
        
        const container = document.createElement('div');
        container.className = 'spotify-player-container';
        container.innerHTML = albumId ?
            `<iframe src="https://open.spotify.com/embed/album/${albumId}" width="100%" height="80" frameborder="0" allowtransparency="true" allow="encrypted-media"></iframe>` +
            `<div style="font-size: 11px; margin-top: 4px; text-align: right; color: #666;">Developed by <a href="https://github.com/w-y-a-t-t/discogs_spotify_extension" style="color: #666; text-decoration: underline;" target="_blank">w-y-a-t-t</a></div>` :
            `<div class="spotify-player-error">Release not found on Spotify</div>`;
        findInjectionPoint().insertBefore(container, findInjectionPoint().firstChild);
    };

    // Detect Various Artists
    const isVariousArtists = (artist) => {
        if (!artist) return false;
        return [/^various$/i, /^various artists$/i, /^v[\s\/]?a$/i, /^compilation$/i, /^various producers$/i]
            .some(pattern => pattern.test(artist.trim()));
    };

    // Spotify API request with retries
    const spotifyApiRequest = async (url, token, options = {}) => {
        const { method = 'GET', body = null, retries = CONFIG.maxRetries } = options;
        let attempts = 0;

        while (attempts < retries) {
            attempts++;
            try {
                const response = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method,
                        url,
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        data: body ? JSON.stringify(body) : undefined,
                        onload: resolve,
                        onerror: reject,
                        ontimeout: () => reject(new Error('Request timed out'))
                    });
                });

                if (response.status === 429) {
                    const retryAfter = parseInt(response.responseHeaders.match(/retry-after:\s*(\d+)/i)?.[1] || '1');
                    log(`Rate limited, waiting ${retryAfter}s`);
                    await sleep(retryAfter * 1000);
                    continue;
                }
                if (response.status === 401) throw new Error('Token expired or invalid');
                if (response.status < 200 || response.status >= 300) throw new Error(`Spotify API error: ${response.status}`);
                return JSON.parse(response.responseText);
            } catch (error) {
                if (attempts >= retries) throw error;
                log(`Request failed (${attempts}/${retries}), retrying...`, error);
                await sleep(CONFIG.retryDelay);
            }
        }
    };

    // Search Spotify album
    const searchSpotifyAlbum = async (title, artist, token) => {
        if (!title || !artist) return null;

        const searchStrategies = isVariousArtists(artist) ?
            [() => `album:${title}`, () => title.split(' ').slice(0, 3).join(' '), () => title] :
            [() => `album:${title} artist:${artist}`, () => `artist:${artist} ${title.split(' ').slice(0, 3).join(' ')}`, () => `${artist} ${title}`];

        for (const getQuery of searchStrategies) {
            const query = encodeURIComponent(getQuery());
            log('Searching:', query);
            try {
                const data = await spotifyApiRequest(`${CONFIG.spotifyApiBase}/search?q=${query}&type=album&limit=10`, token);
                for (const album of data.albums?.items || []) {
                    const spotifyArtist = album.artists[0].name;
                    const spotifyTitle = album.name;
                    const artistSim = similarity(artist, spotifyArtist);
                    const titleSim = similarity(title, spotifyTitle);

                    if (isVariousArtists(artist) ? titleSim > 0.6 : (artistSim > 0.8 && titleSim > 0.6) || (artistSim > 0.7 && titleSim > 0.8)) {
                        log('Match found:', album.id);
                        return album.id;
                    }
                }
            } catch (error) {
                logError('Search failed', error);
            }
        }
        return null;
    };

    // Token management
    const getSpotifyToken = async () => {
        // If we're already showing auth container, don't show another one
        if (authState.isAuthenticating) return null;

        const token = GM_getValue('spotify_token');
        const timestamp = GM_getValue('token_timestamp');
        if (token && timestamp && (Date.now() - timestamp < CONFIG.tokenMaxAge)) return token;

        GM_deleteValue('spotify_token');
        GM_deleteValue('token_timestamp');

        // Only show auth container if it's not already visible
        if (!authState.authContainerVisible) {
            authState.isAuthenticating = true;
            authState.authContainerVisible = true;
            
            const container = document.createElement('div');
            container.className = 'spotify-auth-container';
            container.innerHTML = `<p>Connect to Spotify to see if this release is available to stream.</p><button class="spotify-login-button">Connect Spotify</button>`;
            findInjectionPoint().insertBefore(container, findInjectionPoint().firstChild);

            container.querySelector('button').addEventListener('click', () => {
                GM_setValue('discogs_return_url', window.location.href);
                const authUrl = new URL(CONFIG.authEndpoint);
                authUrl.searchParams.append('client_id', CONFIG.clientId);
                authUrl.searchParams.append('response_type', 'token');
                authUrl.searchParams.append('redirect_uri', CONFIG.redirectUri);
                authUrl.searchParams.append('scope', 'user-read-private');
                GM_openInTab(authUrl.toString(), { active: true });
            });
        }

        return null;
    };

    // Validate token
    const validateToken = async (token) => {
        try {
            await spotifyApiRequest(`${CONFIG.spotifyApiBase}/me`, token);
            // When token is valid, clear auth state
            authState.isAuthenticating = false;
            return true;
        } catch (error) {
            logError('Token validation failed', error);
            GM_deleteValue('spotify_token');
            GM_deleteValue('token_timestamp');
            return false;
        }
    };

    // Check if on Discogs page
    const isDiscogsPage = () => {
        return window.location.hostname === 'www.discogs.com' &&
               (window.location.pathname.includes('/release/') || window.location.pathname.includes('/master/'));
    };

    // Handle Spotify callback
    const handleCallback = () => {
        if (!window.location.hash) return false;
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get('access_token');
        const returnUrl = GM_getValue('discogs_return_url');

        if (token) {
            GM_setValue('spotify_token', token);
            GM_setValue('token_timestamp', Date.now());
            // Reset auth state when we get a token
            authState.isAuthenticating = false;
            if (returnUrl) {
                GM_setValue('discogs_return_url', null);
                window.location.href = returnUrl;
                return true;
            }
        }
        return false;
    };

    // Main initialization
    const init = async () => {
        // Debounce initialization to prevent multiple calls in quick succession
        const now = Date.now();
        if (authState.isInitializing || (now - authState.lastInitTime < CONFIG.initDebounceTime)) {
            log('Initialization already in progress or too soon, skipping');
            return;
        }
        
        authState.isInitializing = true;
        authState.lastInitTime = now;
        
        log('Initializing...', { url: window.location.href });

        if (window.location.href.includes('/callback')) {
            if (handleCallback()) return;
        }

        if (!isDiscogsPage()) {
            authState.isInitializing = false;
            return;
        }

        const pageLoaded = await waitForPageLoad();
        if (!pageLoaded) {
            logError('Page not fully loaded after timeout');
            authState.isInitializing = false;
            return;
        }

        const albumInfo = extractAlbumInfo();
        if (!albumInfo) {
            authState.isInitializing = false;
            return;
        }

        const token = await getSpotifyToken();
        if (!token) {
            // We're showing the auth container, keep isInitializing true
            // It will be reset after authentication completes
            return;
        }

        // Validate token but don't modify DOM if validation fails
        if (!(await validateToken(token))) {
            // Don't remove auth container, just get a new token
            await getSpotifyToken();
            return;
        }

        // If we got here, authentication is complete
        authState.isAuthenticating = false;
        showLoadingIndicator();
        try {
            const albumId = await searchSpotifyAlbum(albumInfo.title, albumInfo.artist, token);
            injectPlayer(albumId);
        } catch (error) {
            logError('Search error', error);
            injectPlayer(null);
        } finally {
            authState.isInitializing = false;
        }
    };

    // Start script
    const start = () => {
        addStyles();
        
        // Use setTimeout to ensure we don't interfere with page load
        setTimeout(() => {
            init().catch(error => {
                logError('Init failed', error);
                authState.isInitializing = false;
            });
        }, 100);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    // Check if we're on the callback page
    if (window.location.pathname === '/callback') {
        // Clear the page content
        document.body.innerHTML = '';
        
        // Create and style a loading container
        const loadingContainer = document.createElement('div');
        loadingContainer.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            background-color: #f5f5f5;
            font-family: Arial, sans-serif;
            z-index: 9999;
        `;
        
        // Add a spinner
        const spinner = document.createElement('div');
        spinner.style.cssText = `
            width: 50px;
            height: 50px;
            border: 5px solid #ddd;
            border-top: 5px solid #007bff;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 20px;
        `;
        
        // Add animation for the spinner
        const styleElement = document.createElement('style');
        styleElement.textContent = `
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(styleElement);
        
        // Add loading text
        const loadingText = document.createElement('h2');
        loadingText.textContent = 'Connecting to Spotify...';
        loadingText.style.cssText = `
            color: #333;
            margin-bottom: 10px;
        `;
        
        // Add subtext
        const subText = document.createElement('p');
        subText.textContent = 'You will be redirected back to Discogs automatically.';
        subText.style.cssText = `
            color: #666;
        `;
        
        // Add Discogs and Spotify logos
        const logoContainer = document.createElement('div');
        logoContainer.style.cssText = `
            display: flex;
            align-items: center;
            margin-top: 30px;
        `;
        
        const discogsLogo = document.createElement('div');
        discogsLogo.textContent = 'Discogs';
        discogsLogo.style.cssText = `
            font-weight: bold;
            font-size: 24px;
            margin-right: 10px;
        `;
        
        const connector = document.createElement('span');
        connector.textContent = '+';
        connector.style.cssText = `
            margin: 0 15px;
            font-size: 24px;
            color: #666;
        `;
        
        const spotifyLogo = document.createElement('div');
        spotifyLogo.textContent = 'Spotify';
        spotifyLogo.style.cssText = `
            color: #1DB954;
            font-weight: bold;
            font-size: 24px;
            margin-left: 10px;
        `;
        
        // Assemble the loading page
        logoContainer.appendChild(discogsLogo);
        logoContainer.appendChild(connector);
        logoContainer.appendChild(spotifyLogo);
        loadingContainer.appendChild(spinner);
        loadingContainer.appendChild(loadingText);
        loadingContainer.appendChild(subText);
        loadingContainer.appendChild(logoContainer);
        document.body.appendChild(loadingContainer);
        
        // Continue with the authentication process
        // ... your existing callback handling code ...
    }
})();