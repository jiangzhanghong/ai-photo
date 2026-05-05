export const getPageChrome = () => {
  const { statusBarHeight = 24, windowWidth = 375 } = wx.getSystemInfoSync();
  const fallback = {
    safeTop: statusBarHeight + 12,
    capsuleGap: 0
  };

  if (typeof wx.getMenuButtonBoundingClientRect !== "function") return fallback;

  try {
    const rect = wx.getMenuButtonBoundingClientRect();
    return {
      safeTop: Math.max(fallback.safeTop, rect.bottom + 8),
      capsuleGap: Math.max(0, windowWidth - rect.left + 8)
    };
  } catch {
    return fallback;
  }
};
