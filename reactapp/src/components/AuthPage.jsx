import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import logoImg from '../assets/logo.png';
import genieVideo from '../assets/genie.mp4';
import { useAuth } from '../context/AuthContext';

function AuthPage() {
  const [activeView, setActiveView] = useState('login');
  const [showPopup, setShowPopup] = useState(false);
  const navigate = useNavigate();
  const { login, register } = useAuth();

  // ===== Registration State =====
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regMobile, setRegMobile] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [regErrors, setRegErrors] = useState({});
  const [isRegistering, setIsRegistering] = useState(false);

  // ===== Password Validation Rules (Regex-based) =====
  const passwordRules = [
    { label: 'Minimum 8 characters', test: (pw) => pw.length >= 8 },
    { label: 'At least 1 uppercase letter', test: (pw) => /[A-Z]/.test(pw) },
    { label: 'At least 1 lowercase letter', test: (pw) => /[a-z]/.test(pw) },
    { label: 'At least 1 number', test: (pw) => /[0-9]/.test(pw) },
    { label: 'At least 1 special character', test: (pw) => /[!@#$%^&*(),.?":{}|<>]/.test(pw) },
  ];

  // Count how many password rules are satisfied
  const satisfiedCount = passwordRules.filter((rule) => rule.test(regPassword)).length;

  // Determine password strength based on how many rules pass
  const getPasswordStrength = () => {
    if (regPassword.length === 0) return null;
    if (satisfiedCount < 3) return { label: 'Weak', color: '#ff4d4d' };
    if (satisfiedCount < 5) return { label: 'Medium', color: '#ffc107' };
    return { label: 'Strong', color: '#4caf50' };
  };

  const passwordStrength = getPasswordStrength();

  // ===== Clear Registration Form =====
  const clearRegForm = () => {
    setRegName('');
    setRegEmail('');
    setRegMobile('');
    setRegPassword('');
    setRegConfirmPassword('');
    setRegErrors({});
    setShowPassword(false);
    setShowConfirmPassword(false);
  };

  // ===== View Switching =====
  const switchToLogin = () => {
    clearRegForm();
    setActiveView('login');
  };

  const switchToRegister = () => {
    setActiveView('register');
  };

  // ===== Login Submit =====
  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('login-email').value;
    const passwordInput = document.getElementById('login-password').value;

    const btn = e.target.querySelector('.btn-primary');
    const originalText = btn.textContent;
    btn.textContent = 'Authenticating...';
    btn.style.opacity = '0.8';
    btn.style.pointerEvents = 'none';

    try {
      await login(emailInput, passwordInput);
      btn.textContent = originalText;
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      navigate('/profile');
    } catch (err) {
      btn.textContent = originalText;
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      alert(err.message || "Invalid credentials");
    }
  };

  // ===== Registration Submit with Full Validation =====
  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    const errors = {};

    if (!regName.trim()) errors.name = 'Full name is required';
    if (!regEmail.trim()) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regEmail)) {
      errors.email = 'Please enter a valid email address';
    }
    if (!regMobile.trim()) {
      errors.mobile = 'Mobile number is required';
    } else if (!/^[6-9]\d{9}$/.test(regMobile)) {
      errors.mobile = 'Enter a valid 10-digit Indian mobile number';
    }
    if (!regPassword) {
      errors.password = 'Password is required';
    } else if (satisfiedCount < 5) {
      errors.password = 'Password must satisfy all strength requirements';
    }
    if (!regConfirmPassword) {
      errors.confirmPassword = 'Please confirm your password';
    } else if (regPassword !== regConfirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }

    setRegErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsRegistering(true);
    try {
      await register(regName, regEmail, regPassword, regMobile);
      setIsRegistering(false);
      setShowPopup(true);
    } catch (err) {
      setIsRegistering(false);
      alert(err.message || "Registration failed");
    }
  };

  const handlePopupOk = () => {
    setShowPopup(false);
    clearRegForm();
    navigate('/profile');
  };

  return (
    <>
      <div className="video-container">
        <div className="overlay"></div>
        <video autoPlay muted playsInline aria-hidden="true" id="bg-video">
          <source src={genieVideo} type="video/mp4" />
          Your browser does not support the video tag.
        </video>
      </div>

      <main className="ui-layer">
        <div className="glass-card login-card visible" id="login-container">
          <div className="card-header">
            <div className="logo-icon">
              <img src={logoImg} alt="Wealth Genie Logo" />
            </div>
            <h1>Wealth Genie</h1>
            <p className="subtitle">Architecting Your Financial Future with AI Intelligence</p>
          </div>

          <div id="forms-container">
            <div className={`form-view ${activeView === 'login' ? 'active' : 'hidden'}`} id="login-view">
              <form id="login-form" onSubmit={handleLoginSubmit}>
                <div className="input-group">
                  <label htmlFor="login-email">Username</label>
                  <input type="text" id="login-email" placeholder="e.g. admin" required autoComplete="username" />
                </div>
                <div className="input-group">
                  <label htmlFor="login-password">Password</label>
                  <div className="password-wrapper">
                    <input 
                       type={showPassword ? 'text' : 'password'} 
                       id="login-password" 
                       placeholder="********"
                       required 
                    />
                    <button
                      type="button"
                      className="toggle-password-btn"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff size={16} color="#94a3b8" /> : <Eye size={16} color="#94a3b8" />}
                    </button>
                  </div>
                </div>
                <div className="form-actions">
                  <span className="forgot-password" role="status">
                    Password recovery is not available in this version.
                  </span>
                </div>
                <button type="submit" className="btn-primary">Login</button>
              </form>
              <div className="card-footer">
                <p>New to Wealth Genie? <a href="#" onClick={(e) => { e.preventDefault(); switchToRegister(); }}>Register</a></p>
              </div>
            </div>

            <div className={`form-view ${activeView === 'register' ? 'active' : 'hidden'}`} id="register-view">
              <form id="register-form" onSubmit={handleRegisterSubmit} noValidate autoComplete="off">
                <div className="input-group">
                  <label htmlFor="reg-name">Full Name</label>
                  <input
                    type="text"
                    id="reg-name"
                    placeholder="Enter your full name"
                    value={regName}
                    onChange={(e) => { setRegName(e.target.value); setRegErrors((prev) => ({ ...prev, name: '' })); }}
                    className={regErrors.name ? 'input-error' : ''}
                    autoComplete="off"
                  />
                  {regErrors.name && <span className="error-msg">{regErrors.name}</span>}
                </div>
                <div className="input-group">
                  <label htmlFor="reg-email">Email Address</label>
                  <input
                    type="email"
                    id="reg-email"
                    placeholder="example@gmail.com"
                    value={regEmail}
                    onChange={(e) => { setRegEmail(e.target.value); setRegErrors((prev) => ({ ...prev, email: '' })); }}
                    className={regErrors.email ? 'input-error' : ''}
                    autoComplete="off"
                  />
                  {regErrors.email && <span className="error-msg">{regErrors.email}</span>}
                </div>
                <div className="input-group">
                  <label htmlFor="reg-mobile">Mobile Number</label>
                  <input
                    type="tel"
                    id="reg-mobile"
                    placeholder="10-digit mobile number"
                    value={regMobile}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '').slice(0, 10);
                      setRegMobile(val);
                      setRegErrors((prev) => ({ ...prev, mobile: '' }));
                    }}
                    className={regErrors.mobile ? 'input-error' : ''}
                    autoComplete="off"
                  />
                  {regErrors.mobile && <span className="error-msg">{regErrors.mobile}</span>}
                </div>
                <div className="input-group">
                  <label htmlFor="reg-password">Password</label>
                  <div className="password-wrapper">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      id="reg-password"
                      placeholder="Create a strong password"
                      value={regPassword}
                      onChange={(e) => { setRegPassword(e.target.value); setRegErrors((prev) => ({ ...prev, password: '' })); }}
                      className={regErrors.password ? 'input-error' : ''}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      className="toggle-password-btn"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff size={16} color="#94a3b8" /> : <Eye size={16} color="#94a3b8" />}
                    </button>
                  </div>
                  {regErrors.password && <span className="error-msg">{regErrors.password}</span>}
                  {regPassword.length > 0 && (
                    <div className="password-checklist">
                      {passwordRules.map((rule, index) => {
                        const passed = rule.test(regPassword);
                        return (
                          <div key={index} className={`checklist-item ${passed ? 'passed' : ''}`}>
                            <span className="checklist-icon">{passed ? '✔' : '✖'}</span>
                            <span className="checklist-label">{rule.label}</span>
                          </div>
                        );
                      })}
                      {passwordStrength && (
                        <div className="password-strength" style={{ color: passwordStrength.color }}>
                          Password Strength: <strong>{passwordStrength.label}</strong>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="input-group">
                  <label htmlFor="reg-confirm-password">Confirm Password</label>
                  <div className="password-wrapper">
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      id="reg-confirm-password"
                      placeholder="Re-enter your password"
                      value={regConfirmPassword}
                      onChange={(e) => { setRegConfirmPassword(e.target.value); setRegErrors((prev) => ({ ...prev, confirmPassword: '' })); }}
                      className={regErrors.confirmPassword ? 'input-error' : ''}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      className="toggle-password-btn"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    >
                      {showConfirmPassword ? <EyeOff size={16} color="#94a3b8" /> : <Eye size={16} color="#94a3b8" />}
                    </button>
                  </div>
                  {regErrors.confirmPassword && <span className="error-msg">{regErrors.confirmPassword}</span>}
                  {regConfirmPassword.length > 0 && !regErrors.confirmPassword && (
                    <span className={`match-indicator ${regPassword === regConfirmPassword ? 'match' : 'no-match'}`}>
                      {regPassword === regConfirmPassword ? '✔ Passwords match' : '✖ Passwords do not match'}
                    </span>
                  )}
                </div>
                <button type="submit" className="btn-primary" disabled={isRegistering}>
                  {isRegistering ? <span className="btn-loading"><span className="spinner"></span> Creating Account...</span> : 'Complete Registration'}
                </button>
              </form>
              <div className="card-footer">
                <p>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); switchToLogin(); }}>Login</a></p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {showPopup && (
        <div className="popup-overlay">
          <div className="popup-card">
            <div className="popup-icon">
              <img src={logoImg} alt="Wealth Genie Logo" />
            </div>
            <h2>Registration Successful!</h2>
            <p>Your Wealth Genie account has been created successfully.</p>
            <button className="btn-primary popup-btn" onClick={handlePopupOk}>OK</button>
          </div>
        </div>
      )}
    </>
  );
}

export default AuthPage;
