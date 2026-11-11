'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import styles from '../../../../accounts.module.css';

export default function ResourceDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const accountId = typeof params.id === 'string' ? params.id : params.id?.[0] || '';
  const resourceType = typeof params.resourceType === 'string' ? params.resourceType : params.resourceType?.[0] || '';
  const resourceKey = typeof params.resourceKey === 'string' ? decodeURIComponent(params.resourceKey) : params.resourceKey?.[0] ? decodeURIComponent(params.resourceKey[0]) : '';
  const region = searchParams.get('region') || 'Global';

  const [resourceData, setResourceData] = useState<any>(null);
  const [editedData, setEditedData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [logPage, setLogPage] = useState(0);
  const LOGS_PER_PAGE = 100;

  useEffect(() => {
    fetchResourceData();
  }, [accountId, resourceType, resourceKey]);

  const fetchResourceData = async () => {
    try {
      const response = await fetch(
        `/api/accounts/${accountId}/resources/${resourceType.toLowerCase()}`
      );
      if (!response.ok) throw new Error('Failed to fetch resource data');
      const data = await response.json();

      // Find the specific resource
      let found = null;
      Object.entries(data).forEach(([key, value]: [string, any]) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          // Check if this is a container
          const containerNames = ['parameters', 'keys', 'buckets', 'roles', 'users', 'policies', 'functions', 'topics', 'queues', 'tables', 'trails', 'loggroups', 'alarms', 'subnets', 'instances', 'networks', 'vpcs', 'routetables', 'networkacls', 'securitygroups'];
          const isContainer = containerNames.includes(key.toLowerCase());
          
          if (isContainer && value[resourceKey]) {
            found = value[resourceKey];
          }
        }
      });

      if (!found && data[resourceKey]) {
        found = data[resourceKey];
      }

      if (!found) {
        throw new Error(`Resource ${resourceKey} not found`);
      }

      setResourceData(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load resource data');
    } finally {
      setLoading(false);
    }
  };

  const formatValue = (value: any): string => {
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    if (typeof value === 'number' && value > 1000000000 && value < 9999999999999) {
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }
    return String(value);
  };

  const isMultiline = (value: any): boolean => {
    if (typeof value === 'object') return true;
    if (typeof value === 'string' && (value.includes('\n') || (value.includes(',') && value.length > 200))) return true;
    return false;
  };

  const handleEditClick = () => {
    setEditedData(JSON.parse(JSON.stringify(resourceData)));
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setEditedData(null);
    setIsEditing(false);
  };

  const handleFieldChange = (key: string, value: any) => {
    setEditedData({
      ...editedData,
      [key]: value
    });
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const response = await fetch(
        `/api/accounts/${accountId}/resources/${resourceType.toLowerCase()}/persist`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: resourceKey,
            data: editedData
          })
        }
      );

      if (!response.ok) throw new Error('Failed to save resource');
      setResourceData(editedData);
      setIsEditing(false);
      setEditedData(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error saving resource');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href={`/dashboard/accounts/${accountId}/resources/${resourceType}?region=${region}`} className={styles.backButton}>← Back</Link>
          <h1>Loading...</h1>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href={`/dashboard/accounts/${accountId}/resources/${resourceType}?region=${region}`} className={styles.backButton}>← Back</Link>
          <h1>Error</h1>
        </div>
        <p style={{ color: 'red' }}>Error: {error}</p>
      </div>
    );
  }

  if (!resourceData) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href={`/dashboard/accounts/${accountId}/resources/${resourceType}?region=${region}`} className={styles.backButton}>← Back</Link>
          <h1>Not Found</h1>
        </div>
        <p>Resource not found</p>
      </div>
    );
  }

  // Separate fields
  const singleLineFields: [string, any][] = [];
  const multiLineFields: [string, any][] = [];
  const logEntries = resourceData.logEntries || [];

  Object.entries(resourceData).forEach(([key, value]) => {
    if (key.startsWith('_') || key === 'logEntries') return;
    if (isMultiline(value)) {
      multiLineFields.push([key, value]);
    } else {
      singleLineFields.push([key, value]);
    }
  });

  // Pagination for logs
  const isCloudWatchLog = logEntries.length > 0 && resourceType.toLowerCase() === 'cloudwatch';
  const sortedLogs = [...logEntries].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const totalPages = Math.ceil(sortedLogs.length / LOGS_PER_PAGE);
  const paginatedLogs = sortedLogs.slice(logPage * LOGS_PER_PAGE, (logPage + 1) * LOGS_PER_PAGE);

  return (
    <div className={styles.container}>
      <div className={styles.header} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Link href={`/dashboard/accounts/${accountId}/resources/${resourceType}?region=${region}`} className={styles.backButton}>← Back to {resourceType}</Link>
          <h1>{resourceKey}</h1>
        </div>
        {!isEditing && (
          <button
            onClick={handleEditClick}
            style={{
              padding: '8px 16px',
              backgroundColor: '#0066cc',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.9em',
              height: 'fit-content'
            }}
          >
            Edit
          </button>
        )}
      </div>

      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px', marginBottom: '20px' }}>
        <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Details</h2>
        
        {isEditing ? (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '12px', alignItems: 'start' }}>
              {singleLineFields.map(([key, value]) => (
                <div key={key} style={{ display: 'contents' }}>
                  <label style={{ fontWeight: 'bold', color: '#666' }}>
                    {key}
                  </label>
                  <input
                    type="text"
                    value={editedData[key] !== undefined ? String(editedData[key]) : ''}
                    onChange={(e) => handleFieldChange(key, e.target.value)}
                    style={{
                      padding: '8px',
                      border: '1px solid #ddd',
                      borderRadius: '3px',
                      fontSize: '0.9em',
                      fontFamily: 'monospace',
                      width: '100%',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
              ))}
            </div>
            
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #eee' }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#4caf50',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontSize: '0.9em',
                  opacity: saving ? 0.6 : 1
                }}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={handleCancelEdit}
                disabled={saving}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#999',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontSize: '0.9em',
                  opacity: saving ? 0.6 : 1
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '12px', alignItems: 'start' }}>
            {singleLineFields.map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <div style={{ fontWeight: 'bold', color: '#666' }}>
                  {key}
                </div>
                <div style={{ color: '#333', wordBreak: 'break-word' }}>
                  {formatValue(value)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {multiLineFields.length > 0 && (
        <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px' }}>
          <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Advanced</h2>
          
          {multiLineFields.map(([key, value]) => (
            <div key={key} style={{ marginBottom: '20px', borderTop: '1px solid #eee', paddingTop: '12px' }}>
              <h3 style={{ marginTop: '0', marginBottom: '8px', fontSize: '0.95em', color: '#666' }}>
                {key}
              </h3>
              <pre style={{
                backgroundColor: '#f5f5f5',
                padding: '12px',
                borderRadius: '3px',
                overflow: 'auto',
                fontSize: '0.85em',
                color: '#333',
                margin: '0'
              }}>
                {formatValue(value)}
              </pre>
            </div>
          ))}
        </div>
      )}

      {isCloudWatchLog && (
        <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px', marginTop: '20px' }}>
          <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Log Entries ({sortedLogs.length} total)</h2>
          
          <div style={{ overflowX: 'auto', marginBottom: '16px', fontSize: '0.85em', fontFamily: 'monospace' }}>
            {paginatedLogs.length > 0 ? (
              <table style={{
                width: '100%',
                borderCollapse: 'collapse'
              }}>
                <tbody>
                  {paginatedLogs.map((log: any, idx: number) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #eee', backgroundColor: idx % 2 === 0 ? '#fafafa' : '#fff' }}>
                      <td style={{ 
                        padding: '8px 12px', 
                        color: '#666',
                        width: '180px',
                        whiteSpace: 'nowrap',
                        fontSize: '0.8em'
                      }}>
                        {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : 'N/A'}
                      </td>
                      <td style={{ 
                        padding: '8px 12px', 
                        color: '#333',
                        wordBreak: 'break-word',
                        maxWidth: '600px'
                      }}>
                        {log.message || '(no message)'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: '#999' }}>No log entries to display</p>
            )}
          </div>

          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center', paddingTop: '12px', borderTop: '1px solid #eee' }}>
              <button
                onClick={() => setLogPage(Math.max(0, logPage - 1))}
                disabled={logPage === 0}
                style={{
                  padding: '6px 12px',
                  backgroundColor: logPage === 0 ? '#e0e0e0' : '#0066cc',
                  color: logPage === 0 ? '#999' : 'white',
                  border: 'none',
                  borderRadius: '3px',
                  cursor: logPage === 0 ? 'not-allowed' : 'pointer',
                  fontSize: '0.85em'
                }}
              >
                ← Previous
              </button>
              
              <span style={{ color: '#666', fontSize: '0.9em', minWidth: '120px', textAlign: 'center' }}>
                Page {logPage + 1} of {totalPages}
              </span>
              
              <button
                onClick={() => setLogPage(Math.min(totalPages - 1, logPage + 1))}
                disabled={logPage === totalPages - 1}
                style={{
                  padding: '6px 12px',
                  backgroundColor: logPage === totalPages - 1 ? '#e0e0e0' : '#0066cc',
                  color: logPage === totalPages - 1 ? '#999' : 'white',
                  border: 'none',
                  borderRadius: '3px',
                  cursor: logPage === totalPages - 1 ? 'not-allowed' : 'pointer',
                  fontSize: '0.85em'
                }}
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
