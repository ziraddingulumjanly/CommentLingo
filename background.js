const DEFAULT_ENABLED = true;
const STORAGE_KEY = 'enabled';

async function getEnabled() {
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  return typeof data[STORAGE_KEY] === 'boolean' ? data[STORAGE_KEY] : DEFAULT_ENABLED;
}

async function updateToolbarBadge(enabled) {
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({
    color: enabled ? '#2EA043' : '#6B7280'
  });

  // Supported by current Chromium versions. If unavailable, the badge still works.
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' }).catch(() => {});
  }

  await chrome.action.setTitle({
    title: enabled
      ? 'YT Comments Auto Translate: ON'
      : 'YT Comments Auto Translate: OFF'
  });
}

async function setEnabled(enabled) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: enabled });
  await updateToolbarBadge(enabled);
}

async function initState() {
  const enabled = await getEnabled();
  await updateToolbarBadge(enabled);
}

async function broadcastState(enabled) {
  const tabs = await chrome.tabs.query({ url: ['*://www.youtube.com/*'] });
  await Promise.allSettled(
    tabs.map((tab) =>
      chrome.tabs.sendMessage(tab.id, { type: 'toggle', enabled })
    )
  );
}

function parseTranslationResponse(data, originalText) {
  let translatedText = '';
  if (Array.isArray(data?.[0])) {
    translatedText = data[0]
      .map((part) => (Array.isArray(part) ? part[0] || '' : ''))
      .join('')
      .trim();
  }

  const detectedLanguage = typeof data?.[2] === 'string' ? data[2] : 'und';

  return {
    translatedText,
    detectedLanguage,
    originalText
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(STORAGE_KEY);
  if (typeof existing[STORAGE_KEY] !== 'boolean') {
    await chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULT_ENABLED });
  }
  await initState();
});

chrome.runtime.onStartup.addListener(initState);
initState();

chrome.action.onClicked.addListener(async () => {
  const current = await getEnabled();
  const next = !current;
  await setEnabled(next);
  await broadcastState(next);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const enabled = await getEnabled();
  chrome.tabs.sendMessage(tabId, { type: 'toggle', enabled }).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab?.url?.includes('youtube.com')) return;
  const enabled = await getEnabled();
  chrome.tabs.sendMessage(tabId, { type: 'toggle', enabled }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'get-state') {
    getEnabled().then((enabled) => sendResponse({ enabled }));
    return true;
  }

  if (message?.type === 'translate' && typeof message.text === 'string') {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', 'en');
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', message.text);

    fetch(url.toString())
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, ...parseTranslationResponse(data, message.text) }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || 'Translation failed'
        })
      );
    return true;
  }
});
