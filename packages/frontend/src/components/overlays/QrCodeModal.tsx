/**
 * QrCodeModal - Shows a QR code for remote device connection.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { apiFetch } from '@/lib/api';
import styles from '@/styles/overlays/QrCodeModal.module.css';

interface RemoteInfo {
  remote: boolean;
  connectUrl?: string;
  token?: string;
  lanUrl?: string;
  tunnelUrl?: string | null;
}

export function QrCodeModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    apiFetch('/api/remote-info')
      .then((r) => r.json())
      .then((data: RemoteInfo) => {
        setInfo(data);
        if (data.remote && data.connectUrl) {
          QRCode.toDataURL(data.connectUrl, {
            width: 240,
            margin: 2,
            color: { dark: '#cdd6f4', light: '#1e1e2e' },
          }).then(setQrDataUrl);
        }
      })
      .catch(() => {});
  }, []);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleCopy = () => {
    if (info?.connectUrl) {
      navigator.clipboard.writeText(info.connectUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>QR Code</h2>
          <button className={styles.closeButton} onClick={onClose}>
            &times;
          </button>
        </div>
        <div className={styles.content}>
          {!info ? (
            <div className={styles.loading}>Loading...</div>
          ) : !info.remote ? (
            <div className={styles.notRemote}>
              Remote mode is not active. QR code is only available when running as a standalone
              executable or with REMOTE=1.
            </div>
          ) : (
            <>
              {qrDataUrl && (
                <div className={styles.qrWrapper}>
                  <img src={qrDataUrl} alt="QR Code" className={styles.qrImage} />
                </div>
              )}
              <div className={styles.subtitle}>Scan with your phone to connect</div>
              {info.tunnelUrl && (
                <div className={styles.urlRow}>
                  <span className={styles.urlLabel}>Tunnel</span>
                  <span className={styles.urlValue}>{info.tunnelUrl}</span>
                </div>
              )}
              <div className={styles.urlRow}>
                <span className={styles.urlLabel}>LAN</span>
                <span className={styles.urlValue}>{info.lanUrl}</span>
              </div>
              <button className={styles.copyButton} onClick={handleCopy}>
                {copied ? 'Copied!' : 'Copy Link'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
