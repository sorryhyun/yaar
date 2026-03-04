import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches render errors in content renderers so a single broken window
 * doesn't crash the entire desktop.
 */
export class RendererErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: '16px',
            color: '#e53e3e',
            fontFamily: 'monospace',
            fontSize: '13px',
          }}
        >
          <strong>Render error</strong>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: '8px' }}>
            {this.state.error?.message || 'Unknown error'}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
