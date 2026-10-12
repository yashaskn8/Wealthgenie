import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  ShieldCheck,
  Target,
} from 'lucide-react';
import genieLampAsset from './assets/logo.png';
import './LandingPage.css';

const HERO_VIDEO = '/media/wealthgenie-hero.mp4';
const HERO_POSTER = '/media/wealthgenie-hero-poster.jpg';

const FEATURE_ITEMS = [
  { icon: BarChart3, label: 'Personalized Advice' },
  { icon: ShieldCheck, label: 'Tax Analysis Tools' },
  { icon: Target, label: 'Long-Term Goals' },
];

function getMediaPreferences() {
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = typeof navigator !== 'undefined' && navigator.connection?.saveData === true;

  return { reducedMotion, saveData };
}

function GenieMark() {
  return (
    <img
      className="wg-landing__logo-lamp"
      src={genieLampAsset}
      alt="WealthGenie golden genie lamp emblem"
      width="507"
      height="288"
      decoding="async"
    />
  );
}

function LandingPage() {
  const heroRef = useRef(null);
  const [preferences, setPreferences] = useState(getMediaPreferences);
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const showVideo = !preferences.reducedMotion && !preferences.saveData && !videoUnavailable;

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const connection = typeof navigator !== 'undefined' ? navigator.connection : undefined;
    const updateMotion = () => {
      const reducedMotion = motionQuery?.matches === true;
      setPreferences((current) => ({ ...current, reducedMotion }));
    };
    const updateData = () => {
      const saveData = connection?.saveData === true;
      setPreferences((current) => ({ ...current, saveData }));
    };

    if (motionQuery?.addEventListener) motionQuery.addEventListener('change', updateMotion);
    else motionQuery?.addListener?.(updateMotion);
    connection?.addEventListener?.('change', updateData);

    return () => {
      if (motionQuery?.removeEventListener) motionQuery.removeEventListener('change', updateMotion);
      else motionQuery?.removeListener?.(updateMotion);
      connection?.removeEventListener?.('change', updateData);
    };
  }, []);

  useEffect(() => {
    const hero = heroRef.current;
    if (!hero || preferences.reducedMotion || preferences.saveData) return undefined;

    const finePointer = window.matchMedia?.('(pointer: fine)');
    if (finePointer && !finePointer.matches) return undefined;

    let frame = 0;
    const resetDepth = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        hero.style.setProperty('--scene-tilt-x', '0deg');
        hero.style.setProperty('--scene-tilt-y', '0deg');
        hero.style.setProperty('--scene-light-x', '50%');
        hero.style.setProperty('--scene-light-y', '42%');
      });
    };
    const updateDepth = (event) => {
      const bounds = hero.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1));
      const y = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1));
      const lightX = ((event.clientX - bounds.left) / bounds.width) * 100;
      const lightY = ((event.clientY - bounds.top) / bounds.height) * 100;

      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        hero.style.setProperty('--scene-tilt-x', (x * 0.34).toFixed(2) + 'deg');
        hero.style.setProperty('--scene-tilt-y', (y * -0.24).toFixed(2) + 'deg');
        hero.style.setProperty('--scene-light-x', lightX.toFixed(1) + '%');
        hero.style.setProperty('--scene-light-y', lightY.toFixed(1) + '%');
      });
    };

    hero.addEventListener('pointermove', updateDepth, { passive: true });
    hero.addEventListener('pointerleave', resetDepth);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      hero.removeEventListener('pointermove', updateDepth);
      hero.removeEventListener('pointerleave', resetDepth);
      hero.style.setProperty('--scene-tilt-x', '0deg');
      hero.style.setProperty('--scene-tilt-y', '0deg');
    };
  }, [preferences.reducedMotion, preferences.saveData]);

  const handleVideoError = () => {
    setVideoUnavailable(true);
  };

  return (
    <div className="wg-landing">
      <a className="wg-landing__skip-link" href="#wg-landing-main">
        Skip to main content
      </a>

      <section className="wg-landing__hero" ref={heroRef} aria-label="WealthGenie introduction" data-motion={preferences.reducedMotion ? 'reduced' : 'full'}>
        <div className="wg-landing__media" aria-hidden="true">
          <img className="wg-landing__poster" src={HERO_POSTER} alt="" />
          {showVideo && (
            <video
              className="wg-landing__video"
              autoPlay
              muted
              loop
              playsInline
              poster={HERO_POSTER}
              preload="metadata"
              tabIndex={-1}
              onError={handleVideoError}
            >
              <source src={HERO_VIDEO} type="video/mp4" />
            </video>
          )}
          <div className="wg-landing__scrim" />
          <div className="wg-landing__lightfield" />
        </div>

        <header className="wg-landing__header">
          <div className="wg-landing__header-inner">
            <Link className="wg-landing__brand" to="/" aria-label="WealthGenie home">
              <GenieMark />
              <span className="wg-landing__brand-copy">
                <span className="wg-landing__wordmark">
                  WEALTH<span>GENIE</span>
                </span>
                <span className="wg-landing__tagline">PLAN SMARTER. LIVE BRIGHTER.</span>
              </span>
            </Link>

            <div className="wg-landing__header-actions">
              <Link className="wg-landing__login" to="/login">Log In</Link>
            </div>
          </div>
        </header>

        <main className="wg-landing__main" id="wg-landing-main" tabIndex={-1}>
          <div className="wg-landing__copy">
            <p className="wg-landing__badge">
              <span aria-hidden="true">✦</span>
              AI-ASSISTED FINANCIAL GUIDANCE
            </p>
            <h1 className="wg-landing__title">
              <span>Smarter Investments,</span>
              <span className="wg-landing__title-accent">A Brighter Tomorrow</span>
            </h1>
            <p className="wg-landing__subtitle">
              Get personalized investment recommendations for your goals, plus tax analysis where the available inputs support it.
            </p>
            <div className="wg-landing__cta-row">
              <Link className="wg-landing__summon" to="/login">
                <span className="wg-landing__cta-arrow" aria-hidden="true"><ArrowRight size={22} strokeWidth={1.9} /></span>
                <span>Summon Genie</span>
              </Link>
            </div>
          </div>
        </main>

        <section className="wg-landing__feature-strip" id="features" aria-label="WealthGenie features">
          {FEATURE_ITEMS.map(({ icon: Icon, label }, index) => (
            <div className="wg-landing__feature" key={label}>
              {index > 0 && <span className="wg-landing__feature-divider" aria-hidden="true" />}
              <Icon className="wg-landing__feature-icon" size={27} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </div>
          ))}
        </section>
      </section>

    </div>
  );
}

export default LandingPage;
