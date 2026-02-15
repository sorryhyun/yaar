/**
 * IframeRenderer - Embeds external websites in a window.
 *
 * Detects CSP/X-Frame-Options blocking and reports back to the AI.
 */
import { memo, useEffect, useRef, useState, useCallback } from 'react';
import {
  IFRAME_CAPTURE_HELPER_SCRIPT,
  IFRAME_STORAGE_SDK_SCRIPT,
  IFRAME_FETCH_PROXY_SCRIPT,
  IFRAME_APP_PROTOCOL_SCRIPT,
} from '@yaar/shared';
import { resolveAssetUrl, getRemoteConnection } from '@/lib/api';
import { useDesktopStore } from '@/store';
import styles from '@/styles/windows/renderers.module.css';

interface IframeRendererProps {
  data: string | { url: string; sandbox?: string };
  requestId?: string;
  onRenderSuccess?: () => void;
  onRenderError?: (error: string, url: string) => void;
}

type LoadState = 'loading' | 'loaded' | 'error';

// Check if URL is same-origin (relative path or same host)
function isSameOrigin(url: string): boolean {
  if (url.startsWith('/')) return true;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin) return true;
    // In remote mode, treat the backend server as same-origin
    const conn = getRemoteConnection();
    if (conn) {
      const serverOrigin = new URL(conn.serverUrl).origin;
      if (parsed.origin === serverOrigin) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function IframeRenderer({ data, requestId, onRenderSuccess, onRenderError }: IframeRendererProps) {
  const rawUrl = typeof data === 'string' ? data : data.url;
  const resolved = resolveAssetUrl(rawUrl);
  const sessionId = useDesktopStore((s) => s.sessionId);
  const customSandbox = typeof data === 'object' ? data.sandbox : undefined;

  // Append sessionId to same-origin iframe URLs so the fetch proxy script
  // can pass it to /api/fetch for domain permission dialogs
  const url = (() => {
    if (!sessionId || !isSameOrigin(resolved)) return resolved;
    try {
      const u = new URL(resolved, window.location.origin);
      if (!u.searchParams.has('sessionId')) {
        u.searchParams.set('sessionId', sessionId);
      }
      // Return pathname + search to keep it relative
      return u.pathname + u.search;
    } catch {
      return resolved;
    }
  })();
  // For same-origin content (local apps), don't sandbox - it's trusted
  // For cross-origin, apply sandbox to prevent escape attacks
  // allow-same-origin: lets the site access its own localStorage/cookies (required by most sites)
  // allow-scripts: lets the site run JavaScript
  // allow-forms: lets the site submit forms
  const sandbox =
    customSandbox ??
    (isSameOrigin(url) ? undefined : 'allow-scripts allow-forms allow-same-origin');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const reportedRef = useRef(false);

  const reportError = useCallback(
    (message: string) => {
      if (reportedRef.current) return;
      reportedRef.current = true;
      setLoadState('error');
      setErrorMessage(message);
      onRenderError?.(message, url);
    },
    [onRenderError, url],
  );

  // Reset state when URL changes
  useEffect(() => {
    setLoadState('loading');
    setErrorMessage('');
    reportedRef.current = false;
  }, [url]);

  // Listen for CSP violations and handle timeout fallback
  useEffect(() => {
    const handleSecurityViolation = (e: SecurityPolicyViolationEvent) => {
      // Check if this violation is related to our iframe
      if (e.blockedURI) {
        try {
          if (url.includes(new URL(e.blockedURI).hostname)) {
            reportError(`Site blocked iframe embedding (CSP: ${e.violatedDirective})`);
          }
        } catch {
          // Invalid URL in blockedURI, ignore
        }
      }
    };

    document.addEventListener('securitypolicyviolation', handleSecurityViolation);

    // Fallback: If iframe hasn't loaded after timeout, assume it's blocked
    const timeoutId = setTimeout(() => {
      // Use ref to check current state without causing re-renders
      const iframe = iframeRef.current;
      if (iframe && !reportedRef.current) {
        try {
          // This will throw for cross-origin, but if iframe didn't load at all,
          // contentWindow might be null or document might be about:blank
          const doc = iframe.contentDocument;
          if (doc && doc.location.href === 'about:blank') {
            reportError('Site may have blocked iframe embedding (X-Frame-Options or CSP)');
          }
        } catch {
          // Cross-origin - can't check, assume it loaded if no CSP error was caught
        }
      }
    }, 3000);

    return () => {
      document.removeEventListener('securitypolicyviolation', handleSecurityViolation);
      clearTimeout(timeoutId);
    };
  }, [url, reportError]);

  const handleLoad = () => {
    // iframe loaded event fired - but this doesn't mean content loaded successfully
    // CSP blocks happen before this, X-Frame-Options might show error page
    // Check reportedRef to avoid reporting success after an error was already reported
    if (loadState === 'loading' && !reportedRef.current) {
      setLoadState('loaded');

      // Inject capture helper into same-origin iframes (non-compiler-generated ones)
      const iframe = iframeRef.current;
      if (iframe) {
        try {
          const doc = iframe.contentDocument;
          if (doc && !doc.querySelector('script[data-yaar-capture]')) {
            const script = doc.createElement('script');
            script.setAttribute('data-yaar-capture', '1');
            script.textContent = IFRAME_CAPTURE_HELPER_SCRIPT;
            doc.head.appendChild(script);
          }
          if (doc && !doc.querySelector('script[data-yaar-storage]')) {
            const storageScript = doc.createElement('script');
            storageScript.setAttribute('data-yaar-storage', '1');
            storageScript.textContent = IFRAME_STORAGE_SDK_SCRIPT;
            doc.head.appendChild(storageScript);
          }
          if (doc && !doc.querySelector('script[data-yaar-fetch-proxy]')) {
            const fetchProxyScript = doc.createElement('script');
            fetchProxyScript.setAttribute('data-yaar-fetch-proxy', '1');
            fetchProxyScript.textContent = IFRAME_FETCH_PROXY_SCRIPT;
            doc.head.appendChild(fetchProxyScript);
          }
          if (doc && !doc.querySelector('script[data-yaar-app-protocol]')) {
            const appProtocolScript = doc.createElement('script');
            appProtocolScript.setAttribute('data-yaar-app-protocol', '1');
            appProtocolScript.textContent = IFRAME_APP_PROTOCOL_SCRIPT;
            doc.head.appendChild(appProtocolScript);
          }
        } catch {
          // Cross-origin — can't inject, capture helper must be baked in
        }
      }

      // Only report success if we have a requestId (meaning server is waiting for feedback)
      if (requestId) {
        reportedRef.current = true;
        onRenderSuccess?.();
      }
    }
  };

  const handleError = () => {
    reportError('Failed to load iframe content');
  };

  if (loadState === 'error') {
    return (
      <div className={styles.iframeError}>
        <div className={styles.iframeErrorIcon}>🚫</div>
        <div className={styles.iframeErrorTitle}>Cannot embed this site</div>
        <div className={styles.iframeErrorMessage}>{errorMessage}</div>
        <a href={url} target="_blank" rel="noopener noreferrer" className={styles.iframeErrorLink}>
          Open in new tab →
        </a>
      </div>
    );
  }

  return (
    <div className={styles.iframeContainer}>
      {loadState === 'loading' && (
        <div className={styles.iframeLoading}>
          <div className={styles.iframeLoadingSpinner} />
          <span>
            Loading{' '}
            {(() => {
              try {
                return new URL(url, window.location.origin).hostname;
              } catch {
                return url;
              }
            })()}
            ...
          </span>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={url}
        className={styles.iframe}
        {...(sandbox ? { sandbox } : {})}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        loading="lazy"
        title="Embedded content"
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}

export const MemoizedIframeRenderer = memo(IframeRenderer);
