import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Compass, ShieldCheck, Target, Calculator, PieChart, Activity, Sparkles, ChevronRight, Mail, MessageCircle, X, ExternalLink, BookOpen, Lightbulb, CheckCircle, HelpCircle } from 'lucide-react';
/* styles */
import './HelpTourScreen.css';

const HelpTourScreen = () => {
  const [showContactModal, setShowContactModal] = useState(false);
  const [contactSent, setContactSent] = useState(false);
  const [expandedCard, setExpandedCard] = useState(null);
  const [expandedGlossary, setExpandedGlossary] = useState(null);

  const glossary = [
    {
      term: 'SIP',
      fullName: 'Systematic Investment Plan',
      definition: 'Investing a fixed amount regularly (e.g. monthly) rather than a lump sum.',
      learnMore: 'SIP helps average out your purchase costs (Rupee Cost Averaging) and removes the stress of timing the market. By investing regularly, you buy more units when prices are low and fewer when prices are high.'
    },
    {
      term: 'XIRR',
      fullName: 'Extended Internal Rate of Return',
      definition: 'The annualized rate of return for a series of irregular, non-periodic cash flows.',
      learnMore: 'XIRR is the gold standard for calculating SIP returns. Since each installment is held for a different length of time, simple returns fail to measure performance accurately. XIRR calculates the exact rate at which your money compounded.'
    },
    {
      term: 'LTCG',
      fullName: 'Long-Term Capital Gains Tax',
      definition: 'Tax treatment that may apply when an asset is sold after the holding period set by the applicable law.',
      learnMore: 'Rates, thresholds, asset classification and holding periods depend on the selected fiscal-year law and the exact asset/acquisition facts. Use the backend tax view; this glossary does not state a current tax rate.'
    },
    {
      term: 'STCG',
      fullName: 'Short-Term Capital Gains Tax',
      definition: 'Tax applied on profits from selling investments held for a short duration (e.g. under 1 year for equities).',
      learnMore: 'The applicable asset classification, holding-period boundary and rate depend on the selected fiscal-year law and transaction facts. Use the backend tax view rather than a static glossary rate.'
    },
    {
      term: 'CAGR',
      fullName: 'Compound Annual Growth Rate',
      definition: 'The constant rate at which an investment would grow if it grew at a steady compounding rate.',
      learnMore: 'CAGR is a useful tool to compare different investments (like mutual funds vs FDs) over a long period. It shows the smoothed annual return, ignoring short-term volatility.'
    },
    {
      term: 'GBM',
      fullName: 'Geometric Brownian Motion',
      definition: 'A mathematical model used to simulate stock prices and asset values, assuming random changes.',
      learnMore: 'GBM is the foundation of our Monte Carlo engine. It models price paths by combining a steady upward trend (drift) with random fluctuations (diffusion), ensuring values never drop below zero.'
    },
    {
      term: 'QMC',
      fullName: 'Quasi-Monte Carlo',
      definition: 'A simulation method that uses highly uniform sequences (Halton sequences) instead of pure random numbers.',
      learnMore: 'Standard Monte Carlo uses pseudo-random samples. QMC uses low-discrepancy sequences to cover the modeled input space more evenly; any convergence improvement depends on the problem and implementation.'
    },
    {
      term: 'SHAP',
      fullName: 'Shapley Additive exPlanations',
      definition: 'A machine learning explainability method that attributes credit to input features for a prediction.',
      learnMore: 'SHAP breaks down our Random Forest recommendation. It shows exactly how much your Age, Income, and Risk Appetite contributed to the final portfolio suggestion, making the AI transparent.'
    },
    {
      term: 'EEE',
      fullName: 'Exempt-Exempt-Exempt',
      definition: 'A shorthand sometimes used for qualifying contribution, growth and payment exclusions; it is not a universal guarantee.',
      learnMore: 'PPF and Sukanya account exclusions require the account, contribution/payment and statutory conditions to be established. WealthGenie will not infer an exemption from a product name alone.'
    },
    {
      term: 'TDS',
      fullName: 'Tax Deducted at Source',
      definition: 'Tax collected by banks directly before paying out interest or income to you.',
      learnMore: 'TDS thresholds and rates depend on the applicable fiscal-year rules and depositor circumstances. TDS is not necessarily the final tax liability; use the explicit server tax view.'
    },
    {
      term: 'Sharpe Ratio',
      fullName: 'Risk-Adjusted Return Measure',
      definition: 'A metric measuring how much excess return an investment earns relative to the volatility it takes on.',
      learnMore: 'Sharpe ratio is calculated as: (Portfolio Return - Risk-Free Rate) / Volatility. A higher Sharpe ratio means you are getting compensated well for the market risk you are carrying.'
    },
    {
      term: 'Simplex Projection',
      fullName: 'Portfolio Constraint Algorithm',
      definition: 'A mathematical process that clamps portfolio weights to ensure they sum to exactly 100%.',
      learnMore: 'In mean-variance optimization, weights can drift or become negative (short-selling). Simplex projection maps these weights onto a probability simplex, enforcing 0-100% bounds.'
    },
    {
      term: 'Risk Capacity',
      fullName: 'Financial Risk Threshold',
      definition: "An investor's actual financial ability to bear market losses based on age, income, and timeline.",
      learnMore: 'Unlike risk tolerance (which is how you feel), capacity is what you can afford. A young high-income earner with 30 years to retirement has high risk capacity even if they are personally cautious.'
    },
    {
      term: 'Asset Allocation',
      fullName: 'Portfolio Weighting',
      definition: 'Splitting your investments among different classes like equities, debt, gold, and cash.',
      learnMore: 'Asset allocation is the single biggest driver of long-term returns. Spreading your savings across different classes helps manage risk, as they rarely move in lockstep.'
    },
    {
      term: 'Rebalancing',
      fullName: 'Portfolio Readjustment',
      definition: 'Restoring your portfolio to its target percentages when market moves cause them to drift.',
      learnMore: 'If equities rise, your portfolio may become too risky. Rebalancing sells some equities and buys safer debt to bring the portfolio back in line with your risk budget.'
    },
    {
      term: 'NPS',
      fullName: 'National Pension System',
      definition: 'A government retirement savings system with plan-specific investment and withdrawal rules.',
      learnMore: 'Tax eligibility, contribution limits, access rules, and withdrawal treatment depend on the selected fiscal year, regime, account, and current official policy. No tax saving is assumed here.'
    },
    {
      term: 'PPF',
      fullName: 'Public Provident Fund',
      definition: 'A long-term government small-savings scheme whose officially declared rate and applicable terms can change by effective period.',
      learnMore: 'See Where to Invest for the current official administered rate and effective interval. Verify account eligibility, term, liquidity, and tax treatment from current official scheme rules.'
    },
    {
      term: 'SGB',
      fullName: 'Sovereign Gold Bonds',
      definition: 'Government-issued, gold-linked bonds with tranche-specific terms.',
      learnMore: 'Coupon, maturity, liquidity, issue availability, and tax treatment must be verified for the exact tranche and selected fiscal year. WealthGenie does not treat a legacy catalog value as current evidence.'
    },
    {
      term: 'Cess',
      fullName: 'Health & Education Cess',
      definition: 'A levy calculated on tax and surcharge under the applicable fiscal-year policy.',
      learnMore: 'The backend tax calculation applies the selected fiscal-year rate and reports the cess component separately. This glossary does not hardcode a rate.'
    },
    {
      term: 'Marginal Relief',
      fullName: 'Tax Threshold Cushion',
      definition: 'A tax discount preventing tax spikes when income slightly crosses a slab boundary.',
      learnMore: 'If you earn ₹12,00,005, you shouldn\'t pay ₹80,000 in tax just for earning ₹5 above the limit. Marginal relief caps your tax to the excess income, which is ₹5.'
    }
  ];

  const guides = [
    {
      icon: PieChart, color: '#0ea5e9', colorRgb: '14, 165, 233',
      title: 'Strategy Dashboard',
      tag: 'Core Engine',
      desc: 'The core control center. Utilizes a multi-layered allocation engine to map your specific age and risk appetite to a mathematically optimal basket of assets.',
      details: 'Displays server-generated projections and allocation assumptions for the saved Financial Profile. Open an instrument to inspect the projection basis and suitability details.',
      step: '01'
    },
    {
      icon: Calculator, color: '#10b981', colorRgb: '16, 185, 129',
      title: 'Post-Tax Analysis & Tax Optimizer',
      tag: 'Tax Intelligence',
      desc: "These modules don't just look at nominal returns. They calculate exact Indian IT slabs (Old vs New Regime) and deduct STCG/LTCG mathematically.",
      details: 'Visualize the real spending power of your investments after tax deductions. Compare Old vs New regime side-by-side to pick the optimal strategy.',
      step: '02'
    },
    {
      icon: Activity, color: '#f59e0b', colorRgb: '245, 158, 11',
      title: 'Rebalancer & SIP Step-Up',
      tag: 'Active Tools',
      desc: 'Markets drift. The Rebalancer lets you propose allocation changes while the server validates the complete portfolio and calculates the resulting projection.',
      details: 'The SIP Planner sends your explicit contribution and step-up assumptions to the server so you can compare the modeled outcomes.',
      step: '03'
    },
    {
      icon: Target, color: '#8b5cf6', colorRgb: '139, 92, 246',
      title: 'Goals & Planning',
      tag: 'Financial Planning',
      desc: 'Set financial goals and track progress toward the milestones that matter to you.',
      details: 'Use the goal planner to explore contribution plans and review progress against your saved financial profile.',
      step: '04'
    },
    {
      icon: ShieldCheck, color: '#f43f5e', colorRgb: '244, 63, 94',
      title: 'AI Genie Assistant',
      tag: 'Generative AI',
      desc: 'Accessible via the glowing orb in the bottom right. Our generative AI is fully context-aware of your uploaded profile.',
      details: 'Ask analytical questions about your specific strategy — "What if I increase SIP by 5K?", "How does my tax look under new regime?", or "Am I on track for retirement?".',
      step: '05'
    }
  ];

  const handleContactSubmit = () => {
    setContactSent(true);
    setTimeout(() => {
      setContactSent(false);
      setShowContactModal(false);
    }, 2500);
  };

  return (
    <div className="help-page">
      {/* Ambient */}
      <div className="help-ambient">
        <div className="help-orb help-orb-1" />
        <div className="help-orb help-orb-2" />
      </div>

      {/* Header */}
      <motion.div
        className="help-header"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="help-badge">
          <BookOpen size={12} /> Platform Documentation
        </div>
        <h1 className="help-title">
          <span className="help-icon-wrap">
            <Compass size={22} color="#38bdf8" />
          </span>
          Platform{' '}
          <span className="help-title-accent">Guide</span>
        </h1>
        <p className="help-subtitle">
          Master the WealthGenie Advisor Portal. Here is a breakdown of the deep-analytics engines available in your sidebar.
        </p>
        <div className="help-header-divider" />
      </motion.div>

      {/* Guide Cards */}
      <div className="help-guides">
        {guides.map((g, i) => {
          const IconComp = g.icon;
          const isExpanded = expandedCard === i;
          return (
            <motion.div
              key={i}
              className={`help-guide-card ${isExpanded ? 'help-guide-expanded' : ''}`}
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              style={{ '--guide-color': g.color, '--guide-rgb': g.colorRgb }}
              onClick={() => setExpandedCard(isExpanded ? null : i)}
            >
              {/* Left accent bar */}
              <div className="help-guide-accent" style={{ background: `linear-gradient(180deg, ${g.color}, transparent)` }} />

              {/* Step number */}
              <div className="help-guide-step">{g.step}</div>

              <div className="help-guide-icon" style={{
                background: `linear-gradient(135deg, ${g.color}18, ${g.color}08)`,
                border: `1px solid ${g.color}30`,
                boxShadow: `0 0 24px ${g.color}10`
              }}>
                <IconComp size={24} color={g.color} />
              </div>

              <div className="help-guide-content">
                <div className="help-guide-title-row">
                  <h3 className="help-guide-title">{g.title}</h3>
                  <span className="help-guide-tag" style={{
                    color: g.color,
                    background: `${g.color}10`,
                    borderColor: `${g.color}25`
                  }}>{g.tag}</span>
                </div>
                <p className="help-guide-desc">{g.desc}</p>

                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="help-guide-details"
                    >
                      <div className="help-guide-details-inner">
                        <Lightbulb size={14} color={g.color} style={{ flexShrink: 0, marginTop: 2 }} />
                        <span>{g.details}</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <ChevronRight
                size={18}
                className={`help-guide-chevron ${isExpanded ? 'help-guide-chevron-open' : ''}`}
                color="#475569"
              />
            </motion.div>
          );
        })}
      </div>

      {/* Financial Jargon Buster Section */}
      <motion.div
        className="help-glossary-section"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
      >
        <div className="help-badge">
          <HelpCircle size={12} /> Jargon Buster
        </div>
        <h2 className="help-section-title">Financial Glossary</h2>
        <p className="help-section-desc">
          Confused by financial acronyms and math terms? Click on any card below to reveal plain-English explanations.
        </p>

        <div className="help-glossary-grid">
          {glossary.map((item, i) => {
            const isExpanded = expandedGlossary === i;
            return (
              <motion.div
                key={i}
                className={`help-glossary-card ${isExpanded ? 'help-glossary-expanded' : ''}`}
                onClick={() => setExpandedGlossary(isExpanded ? null : i)}
                layout
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              >
                <div className="help-glossary-card-header">
                  <div className="help-glossary-term-group">
                    <span className="help-glossary-term">{item.term}</span>
                    <span className="help-glossary-fullname">({item.fullName})</span>
                  </div>
                  <ChevronRight
                    size={16}
                    className={`help-glossary-chevron ${isExpanded ? 'help-glossary-chevron-open' : ''}`}
                  />
                </div>
                <p className="help-glossary-definition">{item.definition}</p>
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className="help-glossary-more"
                    >
                      <div className="help-glossary-more-inner">
                        <Lightbulb size={14} color="#38bdf8" style={{ flexShrink: 0, marginTop: 2 }} />
                        <span className="help-glossary-more-text">{item.learnMore}</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </motion.div>

      {/* Footer CTA */}
      <motion.div
        className="help-cta-card"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
      >
        <div className="help-cta-glow" />
        <div className="help-cta-icon">
          <MessageCircle size={24} color="#38bdf8" />
        </div>
        <h3 className="help-cta-title">Need Human Support?</h3>
        <p className="help-cta-desc">
          While the algorithm calculates optimal paths, execution sometimes requires a human touch. Connect with a certified wealth advisor.
        </p>
          <button className="help-cta-btn help-cta-btn-primary" onClick={() => setShowContactModal(true)}>
            <Mail size={15} /> Contact Wealth Manager
          </button>
      </motion.div>

      {/* Contact Modal */}
      <AnimatePresence>
        {showContactModal && (
          <motion.div
             className="help-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowContactModal(false)}
          >
            <motion.div
              className="help-modal"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              onClick={e => e.stopPropagation()}
            >
              {contactSent ? (
                <div className="help-modal-success">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', damping: 12 }}
                  >
                    <CheckCircle size={56} color="#10b981" />
                  </motion.div>
                  <h3>Request Submitted!</h3>
                  <p>A certified wealth advisor will reach out within 24 hours.</p>
                </div>
              ) : (
                <>
                  <button className="help-modal-close" onClick={() => setShowContactModal(false)}>
                    <X size={18} />
                  </button>
                  <div className="help-modal-header">
                    <div className="help-modal-icon">
                      <Mail size={22} color="#38bdf8" />
                    </div>
                    <h3>Contact Wealth Manager</h3>
                    <p>Fill in your details and our certified advisor will get back to you.</p>
                  </div>
                  <div className="help-modal-form">
                    <div className="help-form-group">
                      <label>Full Name</label>
                      <input type="text" placeholder="Your name" className="help-form-input" />
                    </div>
                    <div className="help-form-row">
                      <div className="help-form-group">
                        <label>Email</label>
                        <input type="email" placeholder="you@example.com" className="help-form-input" />
                      </div>
                      <div className="help-form-group">
                        <label>Phone</label>
                        <input type="tel" placeholder="+91 98765 43210" className="help-form-input" />
                      </div>
                    </div>
                    <div className="help-form-group">
                      <label>What do you need help with?</label>
                      <select className="help-form-input">
                        <option>Portfolio Review</option>
                        <option>Tax Optimization</option>
                        <option>Retirement Planning</option>
                        <option>Goal-Based Investment</option>
                        <option>Risk Assessment</option>
                        <option>Other</option>
                      </select>
                    </div>
                    <div className="help-form-group">
                      <label>Message (optional)</label>
                      <textarea className="help-form-input help-form-textarea" placeholder="Describe your query..." rows={3} />
                    </div>
                    <button className="help-form-submit" onClick={handleContactSubmit}>
                      Submit Request <ExternalLink size={14} />
                    </button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default HelpTourScreen;
