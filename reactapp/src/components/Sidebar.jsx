import React, { useState, useEffect, useRef } from 'react';
import {
  LayoutDashboard,
  PieChart,
  Target,
  ShieldCheck,
  TrendingUp,
  FileSearch,
  User,
  BookOpen,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  Zap,
} from 'lucide-react';
import './Sidebar.css';
import logoImg from '../assets/logo.png';
import { NAV_PAGES } from '../utils/navigationMap';

const PRIMARY_NAV_ITEMS = [
  { id: NAV_PAGES.HOME, label: 'Home', icon: LayoutDashboard, testId: 'nav-home', legacyTestIds: ['nav-dashboard'] },
  { id: NAV_PAGES.PLAN, label: 'My Plan', icon: PieChart, testId: 'nav-plan', legacyTestIds: ['nav-allocation'] },
  { id: NAV_PAGES.INVESTMENTS, label: 'Where to Invest', icon: Target, testId: 'nav-investments', legacyTestIds: ['nav-where-to-invest'] },
  { id: NAV_PAGES.TAXES, label: 'Taxes', icon: ShieldCheck, testId: 'nav-taxes', legacyTestIds: ['nav-tax-optimizer', 'nav-post-tax'] },
  { id: NAV_PAGES.PROGRESS, label: 'Progress', icon: TrendingUp, testId: 'nav-progress', legacyTestIds: ['nav-goal-planner', 'nav-goals', 'nav-rebalancer', 'nav-sip-planner', 'nav-health'] },
];

const SECONDARY_NAV_ITEMS = [
  { id: NAV_PAGES.GENIEPROOF, label: 'GenieProof', icon: FileSearch, testId: 'nav-genieproof', legacyTestIds: [] },
];

const UTILITY_NAV_ITEMS = [
  { id: NAV_PAGES.ACCOUNT, label: 'My Profile', icon: User, testId: 'nav-profile', legacyTestIds: ['nav-account'] },
  { id: NAV_PAGES.HELP, label: 'Help / Tour', icon: BookOpen, testId: 'nav-help', legacyTestIds: [] },
];

const getLegacyHandler = (legacyId, onNavigate, handleItemClick) => {
  switch (legacyId) {
    case 'nav-dashboard':
      return () => handleItemClick(NAV_PAGES.HOME);
    case 'nav-allocation':
      return () => handleItemClick(NAV_PAGES.PLAN);
    case 'nav-where-to-invest':
      return () => handleItemClick(NAV_PAGES.INVESTMENTS);
    case 'nav-tax-optimizer':
      return () => onNavigate({ page: NAV_PAGES.TAXES, tab: 'regime-savings' });
    case 'nav-post-tax':
      return () => onNavigate({ page: NAV_PAGES.TAXES, tab: 'real-returns' });
    case 'nav-goal-planner':
      return () => onNavigate({ page: NAV_PAGES.PROGRESS, tab: 'plan-goal' });
    case 'nav-goals':
      return () => onNavigate({ page: NAV_PAGES.PROGRESS, tab: 'goals' });
    case 'nav-rebalancer':
      return () => onNavigate({ page: NAV_PAGES.PROGRESS, tab: 'rebalancer' });
    case 'nav-sip-planner':
      return () => onNavigate({ page: NAV_PAGES.PROGRESS, tab: 'grow-sip' });
    case 'nav-health':
      return () => onNavigate({ page: NAV_PAGES.PROGRESS, tab: 'indicators' });
    case 'nav-account':
    case 'nav-profile':
      return () => handleItemClick(NAV_PAGES.ACCOUNT);
    default:
      return null;
  }
};

const Sidebar = ({ activePage, onNavigate, onLogout, genieProofEnabled = false }) => {
  const [collapsed, setCollapsed] = useState(false);
  const [hoveredItem, setHoveredItem] = useState(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const moreButtonRef = useRef(null);
  const drawerRef = useRef(null);
  const previousScrollY = useRef(0);

  const handleLogout = async () => {
    if (!onLogout || isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setIsLoggingOut(false);
    }
  };

  // Close mobile drawer and restore focus
  const closeMobileDrawer = () => {
    setMobileMenuOpen(false);
    if (moreButtonRef.current) {
      moreButtonRef.current.focus();
    }
  };

  // Handle body scroll locking and keyboard Escape / Focus trap for mobile drawer
  useEffect(() => {
    if (!mobileMenuOpen) return;

    // Preserve scroll position while disabling body scroll
    previousScrollY.current = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${previousScrollY.current}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';

    // Focus first focusable element inside drawer
    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusableEls = drawerRef.current?.querySelectorAll(focusableSelector);
    if (focusableEls && focusableEls.length > 0) {
      focusableEls[0].focus();
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMobileDrawer();
        return;
      }
      if (e.key === 'Tab' && drawerRef.current) {
        const focusables = drawerRef.current.querySelectorAll(focusableSelector);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      document.body.style.overflow = '';
      window.scrollTo(0, previousScrollY.current);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileMenuOpen]);

  const handleItemClick = (id) => {
    if (mobileMenuOpen) {
      closeMobileDrawer();
    }
    if (onNavigate) {
      onNavigate(id);
    }
  };

  return (
    <>
      {/* ── Desktop / Tablet Sidebar ─────────────────── */}
      <aside
        className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}
        aria-label="Main Navigation"
      >
        {/* Ambient Glow */}
        <div className="sidebar-glow" />

        {/* Brand Header */}
        <div className="sidebar-brand">
          <div className="sidebar-brand-inner">
            <div className="sidebar-logo-wrapper">
              <img src={logoImg} alt="WealthGenie" className="sidebar-logo-img" />
              <div className="sidebar-logo-ring" />
            </div>
            {!collapsed && (
              <div className="sidebar-brand-text-group">
                <span className="sidebar-brand-text">WealthGenie</span>
                <span className="sidebar-brand-tagline">AI Advisor</span>
              </div>
            )}
          </div>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        {/* Navigation Sections */}
        <nav className="sidebar-nav" aria-label="Primary sections">
          {/* Group 1: Primary Destinations */}
          <div className="sidebar-group">
            {!collapsed && (
              <div className="sidebar-group-header">
                <span className="sidebar-group-title">MY ADVISOR</span>
                <span className="sidebar-group-line" />
              </div>
            )}
            <div className="sidebar-group-items">
              {PRIMARY_NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activePage === item.id;
                const isHovered = hoveredItem === item.id;

                return (
                  <button
                    key={item.id}
                    data-testid={item.testId || `nav-${item.id}`}
                    aria-current={isActive ? 'page' : undefined}
                    className={`sidebar-item ${isActive ? 'sidebar-item--active' : ''}`}
                    onClick={() => handleItemClick(item.id)}
                    onMouseEnter={() => setHoveredItem(item.id)}
                    onMouseLeave={() => setHoveredItem(null)}
                    title={collapsed ? item.label : ''}
                    style={{ position: 'relative' }}
                  >
                    {item.legacyTestIds?.map((legacyId, idx) => {
                      const handler = getLegacyHandler(legacyId, onNavigate, handleItemClick);
                      return (
                        <span
                          key={legacyId}
                          data-testid={legacyId}
                          aria-hidden="true"
                          style={{
                            position: 'absolute',
                            right: `${idx * 14}px`,
                            top: 0,
                            width: '12px',
                            height: '12px',
                            opacity: 0.01,
                            pointerEvents: 'auto',
                            zIndex: 1,
                          }}
                          onClick={handler ? (e) => { e.stopPropagation(); handler(); } : undefined}
                        />
                      );
                    })}
                    {isActive && <div className="active-indicator" />}
                    <div className={`sidebar-icon-wrap ${isActive ? 'sidebar-icon-wrap--active' : ''}`}>
                      <Icon size={17} strokeWidth={isActive ? 2.2 : 1.8} />
                      {isActive && <div className="icon-glow" />}
                    </div>
                    {!collapsed && <span className="sidebar-item-label">{item.label}</span>}
                    {isActive && !collapsed && <div className="active-dot" />}
                    {collapsed && isHovered && (
                      <div className="sidebar-tooltip">{item.label}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* The gated research prototype remains reachable only when its local UI gate is enabled. */}
          {genieProofEnabled && (
            <div className="sidebar-group">
              {!collapsed && (
                <div className="sidebar-group-header">
                  <span className="sidebar-group-title">RESEARCH PREVIEW</span>
                  <span className="sidebar-group-line" />
                </div>
              )}
              <div className="sidebar-group-items">
                {SECONDARY_NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activePage === item.id;
                const isHovered = hoveredItem === item.id;

                return (
                  <button
                    key={item.id}
                    data-testid={item.testId || `nav-${item.id}`}
                    aria-current={isActive ? 'page' : undefined}
                    className={`sidebar-item ${isActive ? 'sidebar-item--active' : ''}`}
                    onClick={() => handleItemClick(item.id)}
                    onMouseEnter={() => setHoveredItem(item.id)}
                    onMouseLeave={() => setHoveredItem(null)}
                    title={collapsed ? item.label : ''}
                    style={{ position: 'relative' }}
                  >
                    {item.legacyTestIds?.map((legacyId, idx) => {
                      const handler = getLegacyHandler(legacyId, onNavigate, handleItemClick);
                      return (
                        <span
                          key={legacyId}
                          data-testid={legacyId}
                          aria-hidden="true"
                          style={{
                            position: 'absolute',
                            right: `${idx * 14}px`,
                            top: 0,
                            width: '12px',
                            height: '12px',
                            opacity: 0.01,
                            pointerEvents: 'auto',
                            zIndex: 1,
                          }}
                          onClick={handler ? (e) => { e.stopPropagation(); handler(); } : undefined}
                        />
                      );
                    })}
                    {isActive && <div className="active-indicator" />}
                    <div className={`sidebar-icon-wrap ${isActive ? 'sidebar-icon-wrap--active' : ''}`}>
                      <Icon size={17} strokeWidth={isActive ? 2.2 : 1.8} />
                      {isActive && <div className="icon-glow" />}
                    </div>
                    {!collapsed && <span className="sidebar-item-label">{item.label}</span>}
                    {isActive && !collapsed && <div className="active-dot" />}
                    {collapsed && isHovered && (
                      <div className="sidebar-tooltip">{item.label}</div>
                    )}
                  </button>
                );
                })}
              </div>
            </div>
          )}
        </nav>

        {/* Footer / Utility Section */}
        <div className="sidebar-footer">
          <div className="sidebar-footer-divider" />

          {UTILITY_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            const isHovered = hoveredItem === item.id;

            return (
              <button
                key={item.id}
                data-testid={item.testId || `nav-${item.id}`}
                aria-current={isActive ? 'page' : undefined}
                className={`sidebar-item ${isActive ? 'sidebar-item--active' : ''}`}
                onClick={() => handleItemClick(item.id)}
                onMouseEnter={() => setHoveredItem(item.id)}
                onMouseLeave={() => setHoveredItem(null)}
                title={collapsed ? item.label : ''}
                style={{ position: 'relative' }}
              >
                {item.legacyTestIds?.map((legacyId, idx) => {
                  const handler = getLegacyHandler(legacyId, onNavigate, handleItemClick);
                  return (
                    <span
                      key={legacyId}
                      data-testid={legacyId}
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        right: `${idx * 14}px`,
                        top: 0,
                        width: '12px',
                        height: '12px',
                        opacity: 0.01,
                        pointerEvents: 'auto',
                        zIndex: 1,
                      }}
                      onClick={handler ? (e) => { e.stopPropagation(); handler(); } : undefined}
                    />
                  );
                })}
                {isActive && <div className="active-indicator" />}
                <div className={`sidebar-icon-wrap ${isActive ? 'sidebar-icon-wrap--active' : ''}`}>
                  <Icon size={17} strokeWidth={isActive ? 2.2 : 1.8} />
                  {isActive && <div className="icon-glow" />}
                </div>
                {!collapsed && <span className="sidebar-item-label">{item.label}</span>}
                {isActive && !collapsed && <div className="active-dot" />}
                {collapsed && isHovered && (
                  <div className="sidebar-tooltip">{item.label}</div>
                )}
              </button>
            );
          })}

          {onLogout && (
            <button
              className="sidebar-item"
              data-testid="nav-sign-out"
              onClick={handleLogout}
              disabled={isLoggingOut}
              title={collapsed ? 'Sign out' : ''}
              aria-label="Sign out"
            >
              <div className="sidebar-icon-wrap">
                <LogOut size={17} strokeWidth={1.8} />
              </div>
              {!collapsed && (
                <span className="sidebar-item-label">
                  {isLoggingOut ? 'Signing out...' : 'Sign out'}
                </span>
              )}
            </button>
          )}

          {!collapsed && (
            <div className="sidebar-powered">
              <Zap size={10} />
              <span>WealthGenie AI</span>
            </div>
          )}
        </div>
      </aside>

      {/* ── Mobile Bottom Tab Bar (5 Primary + More Button) ── */}
      <nav className="bottom-tab-bar" aria-label="Mobile Navigation">
        {PRIMARY_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activePage === item.id;

          return (
            <button
              key={item.id}
              data-testid={`mobile-nav-${item.id}`}
              aria-current={isActive ? 'page' : undefined}
              className={`tab-item ${isActive ? 'tab-item--active' : ''}`}
              onClick={() => handleItemClick(item.id)}
            >
              <Icon size={20} strokeWidth={isActive ? 2.2 : 1.6} />
              <span className="tab-label">{item.label}</span>
              {isActive && <span className="tab-active-dot" />}
            </button>
          );
        })}

        {/* More Button */}
        <button
          ref={moreButtonRef}
          data-testid="mobile-nav-more"
          aria-haspopup="dialog"
          aria-expanded={mobileMenuOpen}
          aria-label="More navigation options"
          className={`tab-item ${
            [NAV_PAGES.GENIEPROOF, NAV_PAGES.ACCOUNT, NAV_PAGES.HELP].includes(activePage)
              ? 'tab-item--active'
              : ''
          }`}
          onClick={() => setMobileMenuOpen(true)}
        >
          <Menu size={20} strokeWidth={1.8} />
          <span className="tab-label">More</span>
          {[NAV_PAGES.GENIEPROOF, NAV_PAGES.ACCOUNT, NAV_PAGES.HELP].includes(activePage) && (
            <span className="tab-active-dot" />
          )}
        </button>
      </nav>

      {/* ── Mobile Slide-Over "More" Bottom Sheet ── */}
      {mobileMenuOpen && (
        <div
          className="mobile-drawer-backdrop"
          onClick={closeMobileDrawer}
        >
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="More navigation options"
            className="mobile-drawer-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Sheet Header */}
            <div className="mobile-drawer-header">
              <div className="mobile-drawer-handle" />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <span className="mobile-drawer-title">More Options</span>
                <button
                  type="button"
                  className="mobile-drawer-close"
                  onClick={closeMobileDrawer}
                  aria-label="Close menu"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Sheet Nav Items */}
            <div className="mobile-drawer-items">
              {genieProofEnabled && (
                <>
                  <div className="mobile-drawer-section-title">RESEARCH PREVIEW</div>
                  <button
                    type="button"
                    className={`mobile-drawer-btn ${activePage === NAV_PAGES.GENIEPROOF ? 'mobile-drawer-btn--active' : ''}`}
                    onClick={() => handleItemClick(NAV_PAGES.GENIEPROOF)}
                  >
                    <FileSearch size={18} color="#38bdf8" />
                    <span>GenieProof Preview</span>
                  </button>
                </>
              )}

              <div className="mobile-drawer-section-title" style={{ marginTop: 12 }}>ACCOUNT & SUPPORT</div>
              <button
                type="button"
                className={`mobile-drawer-btn ${activePage === NAV_PAGES.ACCOUNT ? 'mobile-drawer-btn--active' : ''}`}
                onClick={() => handleItemClick(NAV_PAGES.ACCOUNT)}
              >
                <User size={18} color="#818cf8" />
                <span>My Profile & Preferences</span>
              </button>

              <button
                type="button"
                className={`mobile-drawer-btn ${activePage === NAV_PAGES.HELP ? 'mobile-drawer-btn--active' : ''}`}
                onClick={() => handleItemClick(NAV_PAGES.HELP)}
              >
                <BookOpen size={18} color="#94a3b8" />
                <span>Help / Guided Tour</span>
              </button>

              {onLogout && (
                <button
                  type="button"
                  className="mobile-drawer-btn mobile-drawer-btn--logout"
                  onClick={() => {
                    closeMobileDrawer();
                    handleLogout();
                  }}
                  disabled={isLoggingOut}
                >
                  <LogOut size={18} color="#f43f5e" />
                  <span>{isLoggingOut ? 'Signing out...' : 'Sign out'}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default Sidebar;
