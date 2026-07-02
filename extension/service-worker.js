// Set up side panel behavior on installation
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.error('Failed to set panel behavior:', error);
  });
});

// Optional: Add event listeners to keep service worker registered
chrome.action.onClicked.addListener(() => {
  // Service worker will wake up when extension icon is clicked
  console.log('Extension icon clicked');
});
