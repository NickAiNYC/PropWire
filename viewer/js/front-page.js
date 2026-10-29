(() => {
  'use strict';

  const menu = document.getElementById('frontMenuDialog');
  const menuButton = document.getElementById('frontMenuBtn');
  const exploreButton = document.getElementById('explorePropsBtn');
  const board = document.getElementById('fullPlayerBoard');
  if (!menu || !menuButton || !exploreButton || !board) return;

  function setBoardOpen(open, scroll = false) {
    document.body.classList.toggle('front-board-open', open);
    if (open) document.getElementById('modeAllBtn')?.click();
    exploreButton.setAttribute('aria-expanded', String(open));
    exploreButton.firstChild.textContent = open ? 'Hide full player board ' : 'Explore all player props ';
    if (scroll) (open ? board : document.getElementById('todaySchedule')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  menuButton.addEventListener('click', () => menu.showModal());
  document.getElementById('frontMenuClose').addEventListener('click', () => menu.close());
  menu.addEventListener('click', (event) => {
    if (event.target === menu) menu.close();
  });
  exploreButton.addEventListener('click', () => setBoardOpen(!document.body.classList.contains('front-board-open'), true));
  menu.querySelector('.front-menu-actions').addEventListener('click', (event) => {
    const action = event.target.closest('[data-front-action]')?.dataset.frontAction;
    if (!action) return;
    menu.close();
    if (action === 'props') setBoardOpen(true, true);
    if (action === 'search') {
      setBoardOpen(true);
      document.querySelector('.pw-command-row')?.classList.add('active');
      document.getElementById('searchInput')?.focus();
    }
    if (action === 'saved') document.getElementById('portfolioBtn')?.click();
    if (action === 'alerts') {
      setBoardOpen(true);
      document.getElementById('availabilityToggle')?.click();
      document.getElementById('availabilityDetails')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (action === 'settings') document.getElementById('mobileMenuBtn')?.click();
    if (action === 'membership') document.getElementById('pricingBtn')?.click();
  });
})();
