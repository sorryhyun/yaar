/**
 * IframeRenderer - Embeds external websites in a window.
 *
 * Detects CSP/X-Frame-Options blocking and reports back to the AI.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import styles from '@/styles/renderers.module.css'

interface IframeRendererProps {
  data: string | { url: string; sandbox?: string }
  requestId?: string
  onRenderSuccess?: () => void
  onRenderError?: (error: string, url: string) => void
}

type LoadState = 'loading' | 'loaded' | 'error'

export function IframeRenderer({ data, requestId, onRenderSuccess, onRenderError }: IframeRendererProps) {
  const url = typeof data === 'string' ? data : data.url
  const sandbox = typeof data === 'object' ? data.sandbox : 'allow-scripts allow-same-origin allow-forms'

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const reportedRef = useRef(false)

  const reportError = useCallback((message: string) => {
    if (reportedRef.current) return
    reportedRef.current = true
    setLoadState('error')
    setErrorMessage(message)
    onRenderError?.(message, url)
  }, [onRenderError, url])

  useEffect(() => {
    // Reset state when URL changes
    setLoadState('loading')
    setErrorMessage('')
    reportedRef.current = false

    // Listen for CSP violations at document level
    const handleSecurityViolation = (e: SecurityPolicyViolationEvent) => {
      // Check if this violation is related to our iframe
      if (e.blockedURI && url.includes(new URL(e.blockedURI).hostname)) {
        reportError(`Site blocked iframe embedding (CSP: ${e.violatedDirective})`)
      }
    }

    document.addEventListener('securitypolicyviolation', handleSecurityViolation)

    // Fallback: If iframe hasn't loaded after timeout, assume it's blocked
    const timeoutId = setTimeout(() => {
      if (loadState === 'loading') {
        // Try to detect if iframe is blank by checking if we can access anything
        const iframe = iframeRef.current
        if (iframe) {
          try {
            // This will throw for cross-origin, but if iframe didn't load at all,
            // contentWindow might be null or document might be about:blank
            const doc = iframe.contentDocument
            if (doc && doc.location.href === 'about:blank') {
              reportError('Site may have blocked iframe embedding (X-Frame-Options or CSP)')
            }
          } catch {
            // Cross-origin - can't check, assume it loaded if no CSP error was caught
          }
        }
      }
    }, 3000)

    return () => {
      document.removeEventListener('securitypolicyviolation', handleSecurityViolation)
      clearTimeout(timeoutId)
    }
  }, [url, loadState, reportError])

  const handleLoad = () => {
    // iframe loaded event fired - but this doesn't mean content loaded successfully
    // CSP blocks happen before this, X-Frame-Options might show error page
    // Check reportedRef to avoid reporting success after an error was already reported
    if (loadState === 'loading' && !reportedRef.current) {
      setLoadState('loaded')
      // Only report success if we have a requestId (meaning server is waiting for feedback)
      if (requestId) {
        reportedRef.current = true
        onRenderSuccess?.()
      }
    }
  }

  const handleError = () => {
    reportError('Failed to load iframe content')
  }

  if (loadState === 'error') {
    return (
      <div className={styles.iframeError}>
        <div className={styles.iframeErrorIcon}>🚫</div>
        <div className={styles.iframeErrorTitle}>Cannot embed this site</div>
        <div className={styles.iframeErrorMessage}>{errorMessage}</div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.iframeErrorLink}
        >
          Open in new tab →
        </a>
      </div>
    )
  }

  return (
    <div className={styles.iframeContainer}>
      {loadState === 'loading' && (
        <div className={styles.iframeLoading}>
          <div className={styles.iframeLoadingSpinner} />
          <span>Loading {new URL(url).hostname}...</span>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={url}
        className={styles.iframe}
        sandbox={sandbox}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        loading="lazy"
        title="Embedded content"
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  )
}
