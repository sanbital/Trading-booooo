// Upbit Boo dashboard identity overlay. Keeps the Original UI/feature surface intact
// while preventing disabled Binance lanes from being presented as active.
(() => {
  const apply = () => {
    document.documentElement.dataset.booInstance = 'upbit';
    const brand = document.querySelector('.brand strong');
    if (brand) brand.textContent = 'UPBIT BOO';
    const subtitle = document.getElementById('brand-subtitle');
    if (subtitle) subtitle.textContent = 'UPBIT KRW SPOT · ORIGINAL STRATEGY CLONE';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
  window.addEventListener('pageshow', apply);
})();
