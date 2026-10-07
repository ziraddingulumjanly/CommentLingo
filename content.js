const STORAGE_KEY = 'enabled';
const SKIP_LANGS = new Set(['en', 'tr']);
const COMMENT_TRANSLATED_ATTR = 'data-yt-comment-translate-processed';
const TRANSLATION_BOX_CLASS = 'yt-comment-auto-translation';

let extensionEnabled = true;
let commentObserver = null;
let pageObserver = null;
let currentUrl = location.href;
const translationCache = new Map();
const inflight = new Map();

function isWatchPage() {
  return location.pathname === '/watch';
}

function getCommentNodes() {
  const all = Array.from(document.querySelectorAll('#content-text'));
  return all.filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (!node.innerText || !node.innerText.trim()) return false;
    return Boolean(
      node.closest(
        'ytd-comment-thread-renderer, ytd-comment-view-model, ytd-comment-renderer, ytd-comment-reply-renderer, ytd-comment-replies-renderer'
      )
    );
  });
}

function findCommentContainer(textNode) {
  return (
    textNode.closest('#body') ||
    textNode.closest('#main') ||
    textNode.parentElement ||
    textNode
  );
}

function cleanupTranslations() {
  document.querySelectorAll(`.${TRANSLATION_BOX_CLASS}`).forEach((node) => node.remove());
  getCommentNodes().forEach((node) => {
    if (node instanceof HTMLElement) {
      node.removeAttribute(COMMENT_TRANSLATED_ATTR);
    }
  });
}

function stopObservers() {
  commentObserver?.disconnect();
  pageObserver?.disconnect();
  commentObserver = null;
  pageObserver = null;
}

function setProcessed(node, value = 'done') {
  if (node instanceof HTMLElement) node.setAttribute(COMMENT_TRANSLATED_ATTR, value);
}

function getProcessed(node) {
  return node instanceof HTMLElement ? node.getAttribute(COMMENT_TRANSLATED_ATTR) : null;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function insertTranslation(textNode, translatedText, sourceLang) {
  const container = findCommentContainer(textNode);
  if (!container) return;

  const existing = container.querySelector(`:scope > .${TRANSLATION_BOX_CLASS}`);
  if (existing) {
    existing.querySelector('.yt-comment-auto-translation__text').textContent = translatedText;
    return;
  }

  const box = document.createElement('div');
  box.className = TRANSLATION_BOX_CLASS;
  box.innerHTML = `
    <div class="yt-comment-auto-translation__label">Translated from ${escapeHtml(sourceLang.toUpperCase())}</div>
    <div class="yt-comment-auto-translation__text"></div>
  `;
  box.querySelector('.yt-comment-auto-translation__text').textContent = translatedText;

  textNode.insertAdjacentElement('afterend', box);
}

function shouldSkipCommentText(text) {
  if (!text) return true;
  if (text.length < 2) return true;
  return false;
}

async function requestTranslation(text) {
  if (translationCache.has(text)) return translationCache.get(text);
  if (inflight.has(text)) return inflight.get(text);

  const promise = chrome.runtime.sendMessage({ type: 'translate', text }).then((response) => {
    inflight.delete(text);
    if (!response?.ok) {
      return { translatedText: '', detectedLanguage: 'und' };
    }

    const result = {
      translatedText: (response.translatedText || '').trim(),
      detectedLanguage: (response.detectedLanguage || 'und').toLowerCase()
    };
    translationCache.set(text, result);
    return result;
  });

  inflight.set(text, promise);
  return promise;
}

async function translateNode(textNode) {
  if (!extensionEnabled || !isWatchPage()) return;
  if (!(textNode instanceof HTMLElement)) return;
  if (getProcessed(textNode)) return;

  const text = textNode.innerText.trim();
  if (shouldSkipCommentText(text)) {
    setProcessed(textNode, 'skip');
    return;
  }

  setProcessed(textNode, 'processing');
  const { translatedText, detectedLanguage } = await requestTranslation(text);

  if (!extensionEnabled) {
    setProcessed(textNode, 'done');
    return;
  }

  if (!translatedText || !detectedLanguage) {
    setProcessed(textNode, 'error');
    return;
  }

  if (SKIP_LANGS.has(detectedLanguage) || translatedText.toLowerCase() === text.toLowerCase()) {
    setProcessed(textNode, 'skip');
    return;
  }

  insertTranslation(textNode, translatedText, detectedLanguage);
  setProcessed(textNode, 'done');
}

function translateVisibleComments() {
  if (!extensionEnabled || !isWatchPage()) return;
  getCommentNodes().forEach((node) => {
    if (!getProcessed(node)) {
      translateNode(node);
    }
  });
}

function observeComments() {
  if (commentObserver) return;

  commentObserver = new MutationObserver((mutations) => {
    let foundCandidate = false;
    for (const mutation of mutations) {
      for (const addedNode of mutation.addedNodes) {
        if (!(addedNode instanceof HTMLElement)) continue;
        if (
          addedNode.matches?.('#content-text') ||
          addedNode.querySelector?.('#content-text') ||
          addedNode.closest?.('ytd-comment-thread-renderer, ytd-comment-reply-renderer, ytd-comment-view-model')
        ) {
          foundCandidate = true;
          break;
        }
      }
      if (foundCandidate) break;
    }

    if (foundCandidate) {
      translateVisibleComments();
    }
  });

  commentObserver.observe(document.body, { childList: true, subtree: true });
}

function observePageChanges() {
  if (pageObserver) return;

  pageObserver = new MutationObserver(() => {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      cleanupTranslations();
      if (extensionEnabled && isWatchPage()) {
        setTimeout(translateVisibleComments, 700);
      }
    }
  });

  pageObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('yt-navigate-finish', () => {
    cleanupTranslations();
    currentUrl = location.href;
    if (extensionEnabled && isWatchPage()) {
      setTimeout(translateVisibleComments, 700);
    }
  });
}

function start() {
  stopObservers();
  if (!extensionEnabled) {
    cleanupTranslations();
    return;
  }
  observeComments();
  observePageChanges();
  setTimeout(translateVisibleComments, 800);
  setTimeout(translateVisibleComments, 1800);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'toggle' && typeof message.enabled === 'boolean') {
    extensionEnabled = message.enabled;
    if (!extensionEnabled) {
      stopObservers();
      cleanupTranslations();
      return;
    }
    start();
  }
});

chrome.runtime.sendMessage({ type: 'get-state' }, (response) => {
  extensionEnabled = typeof response?.enabled === 'boolean' ? response.enabled : true;
  start();
});
