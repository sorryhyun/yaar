/**
 * TableRenderer - Renders tabular data.
 */
import { memo } from 'react';
import styles from '@/styles/window/renderers.module.css';

interface TableRendererProps {
  data: {
    headers: string[];
    rows: string[][];
  };
}

function TableRenderer({ data }: TableRendererProps) {
  if (!data.headers || !data.rows) {
    return <div>Invalid table data</div>;
  }

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          {data.headers.map((header, i) => (
            <th key={i}>{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const MemoizedTableRenderer = memo(TableRenderer);
