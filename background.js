// 蛙蛙写作助手 - 后台 Service Worker
// 职责：配置点击扩展图标打开 Chrome 侧边栏；作为消息桥帮助功能页查找/创建
// 已登录的 wawawriter.com 后台标签页（所有数据请求均由功能页通过
// chrome.scripting 在该标签页内发起，天然携带官方登录 Cookie）。

const WAWA_MATCH = '*://*.wawawriter.com/*';
const POPUP_PAGE = chrome.runtime.getURL('popup.html');

function enableSidePanel() {
  if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);

// 兜底：若浏览器不支持 sidePanel，点击图标时在新标签页打开功能页。
chrome.action.onClicked.addListener(async () => {
  if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    return;
  }
  try {
    await openOrFocusExtensionPage(POPUP_PAGE);
  } catch (error) {
    console.warn('[WawaHelper] 打开功能页失败', error);
  }
});

async function openOrFocusExtensionPage(pageUrl) {
  const tabs = await chrome.tabs.query({ url: pageUrl });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId) {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: pageUrl });
}

// 功能页消息桥：帮助查找/创建 wawawriter.com 标签页。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'getWawaTab') {
    getOrCreateWawaTab(Boolean(message.create))
      .then((tab) => sendResponse({ success: true, tab }))
      .catch((error) => sendResponse({ success: false, error: String(error?.message || error) }));
    return true;
  }
  return false;
});

async function getOrCreateWawaTab(create) {
  const tabs = await chrome.tabs.query({ url: WAWA_MATCH });
  const usable = tabs.find((item) => item.id && !item.discarded && !/\/login/i.test(item.url || ''));
  if (usable) return usable;
  if (!create) return null;
  const created = await chrome.tabs.create({
    url: 'https://wawawriter.com/app/submission',
    active: false
  });
  await waitForTabLoaded(created.id, 45000);
  // SPA 需要额外时间挂载前端应用
  await sleep(1500);
  return created;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoaded(tabId, timeout = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(false), timeout);
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (error) {}
      resolve(ok);
    }
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete') finish(true);
    }).catch(() => finish(false));
  });
}
