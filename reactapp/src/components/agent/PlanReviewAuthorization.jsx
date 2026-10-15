import React, { useEffect, useRef, useState } from 'react';
import api from '../../services/api';
import {
  serializeAuthenticationCredential,
  serializeRegistrationCredential,
  toAuthenticationRequestOptions,
  toRegistrationCreationOptions,
} from '../../services/webAuthnClient';
import VerifiableActionApprovalCard from './VerifiableActionApprovalCard';

function assertBrowserPasskeySupport() {
  if (typeof window === 'undefined' || !window.isSecureContext) {
    throw new Error('Passkey approval requires a secure HTTPS connection (localhost is supported for development).');
  }
  if (!navigator.credentials?.get || !navigator.credentials?.create) {
    throw new Error('This browser does not support passkey approval.');
  }
}

function userMessage(error) {
  if (error?.name === 'NotAllowedError') return 'Passkey verification was cancelled or timed out. No action was executed.';
  return error?.message || 'Passkey authorization is temporarily unavailable.';
}

export function PlanReviewAuthorization({ run, onExecutionComplete }) {
  const mountedRef = useRef(false);
  const [mandate, setMandate] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [needsEnrollment, setNeedsEnrollment] = useState(false);
  const [receiptId, setReceiptId] = useState(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function requestApproval() {
    if (!run?.runId || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.actOnPlanReview(run.runId, 'APPROVE_RECOMPUTE');
      if (result?.authorization?.enabled !== true || !result?.mandate?.mandateId) {
        setMessage('Step-up authorization is not enabled. No financial action was executed.');
        return;
      }
      setMandate(result.mandate);
      setMessage('Review the bound profile snapshot, then approve with your passkey. Approval and execution are separate steps.');
    } catch (cause) {
      setError(userMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function enrollPasskey() {
    if (!mandate || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      assertBrowserPasskeySupport();
      const options = await api.getPasskeyRegistrationOptions();
      const credential = await navigator.credentials.create({ publicKey: toRegistrationCreationOptions(options) });
      if (!credential) throw new Error('The browser did not complete passkey enrollment.');
      await api.verifyPasskeyRegistration(serializeRegistrationCredential(credential));
      setNeedsEnrollment(false);
      setMessage('Passkey enrolled on this account. Select “Verify with passkey” to approve this request.');
    } catch (cause) {
      setError(userMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function approveMandate() {
    if (!mandate || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (mandate.approvalMethod === 'WEBAUTHN') {
        assertBrowserPasskeySupport();
        const result = await api.getMandateApprovalOptions(mandate.mandateId);
        if (result?.provider !== 'WEBAUTHN' || result?.options?.userVerification !== 'required') {
          throw new Error('The server did not provide the required passkey user-verification options.');
        }
        const credential = await navigator.credentials.get({ publicKey: toAuthenticationRequestOptions(result.options) });
        if (!credential) throw new Error('The browser did not return a passkey assertion.');
        await api.verifyMandateApproval(mandate.mandateId, {
          method: 'WEBAUTHN',
          mandateId: mandate.mandateId,
          mandateHash: mandate.mandateHash,
          credentialId: credential.id,
          response: serializeAuthenticationCredential(credential),
        });
      } else if (mandate.approvalMethod === 'DEVELOPMENT') {
        await api.verifyMandateApproval(mandate.mandateId, {
          method: 'DEVELOPMENT', mandateId: mandate.mandateId, mandateHash: mandate.mandateHash,
        });
      } else {
        throw new Error('The mandate uses an unsupported approval method.');
      }
      const refreshed = await api.getAuthorizedMandate(mandate.mandateId);
      if (refreshed?.status !== 'AUTHORIZED') throw new Error('The server did not confirm authorization.');
      setMandate(refreshed);
      setMessage('Passkey approval verified. The recompute has not run yet; choose Execute to continue.');
    } catch (cause) {
      if (cause?.status === 428 || cause?.code === 'STEP_UP_ENROLLMENT_REQUIRED') setNeedsEnrollment(true);
      setError(userMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function rejectMandate() {
    if (!mandate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const revoked = await api.revokeAuthorizedMandate(mandate.mandateId, 'User rejected this proposed recompute.');
      setMandate(revoked);
      setMessage('Request rejected. No recompute was executed.');
    } catch (cause) {
      setError(userMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function executeMandate() {
    if (!mandate || mandate.status !== 'AUTHORIZED' || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.executeAuthorizedMandate(mandate.mandateId);
      if (!mountedRef.current) return;
      const newReceiptId = result?.receipt?.receiptId || null;
      setReceiptId(newReceiptId);
      setMandate(current => ({ ...current, status: 'EXECUTED', receiptId: newReceiptId }));
      setMessage('Authorized recompute completed. The application is reconciling the canonical current plan.');
      await onExecutionComplete?.(result?.response || null);
    } catch (cause) {
      if (mountedRef.current) setError(userMessage(cause));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  if (!mandate) {
    return (
      <div className="ap-review-actions">
        <button type="button" className="ap-review-primary ap-review-recompute" onClick={requestApproval} disabled={!run?.runId || busy}>
          {busy ? 'Preparing approval…' : 'Request step-up approval'}
        </button>
        {message ? <p role="status">{message}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <VerifiableActionApprovalCard
      mandate={mandate}
      onApprove={approveMandate}
      onReject={rejectMandate}
      onExecute={executeMandate}
      onEnroll={enrollPasskey}
      busy={busy}
      needsEnrollment={needsEnrollment}
      statusMessage={message}
      errorMessage={error}
      receiptId={receiptId}
    />
  );
}

export default PlanReviewAuthorization;
