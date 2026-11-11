'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import styles from '../../../accounts.module.css';

interface ResourceData {
  [key: string]: any;
}

export default function ResourceListPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const accountId = typeof params.id === 'string' ? params.id : params.id?.[0] || '';
  const resourceType = typeof params.resourceType === 'string' ? params.resourceType : params.resourceType?.[0] || '';
  const region = searchParams.get('region') || 'Global';

  const [data, setData] = useState<ResourceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<string | null>(null);

  useEffect(() => {
    fetchResourceData();
  }, [accountId, resourceType]);

  useEffect(() => {
    // Set first tab as default when types are available
    const types = getResourceTypes();
    if (types.length > 0 && !selectedTab) {
      setSelectedTab(types[0]);
    }
  }, [data, selectedTab]);

  const getDetailPageUrl = (type: string, key: string): string => {
    // Map resource type containers to their specialized detail page paths
    const resourceTypeMap: { [key: string]: string } = {
      'routetables': 'routetables',
      'networkacls': 'networkacls',
      'securitygroups': 'securitygroups'
    };
    
    const mappedType = resourceTypeMap[type.toLowerCase()] || type;
    return `/dashboard/accounts/${accountId}/resources/${mappedType}/${encodeURIComponent(key)}?region=${region}`;
  };

  const fetchResourceData = async () => {
    try {
      const response = await fetch(
        `/api/accounts/${accountId}/resources/${resourceType.toLowerCase()}`
      );
      if (!response.ok) throw new Error('Failed to fetch resource data');
      const fetchedData = await response.json();
      setData(fetchedData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load resource data');
    } finally {
      setLoading(false);
    }
  };

  const isMultiline = (value: any): boolean => {
    if (typeof value === 'object' && value !== null) return true;
    if (typeof value === 'string' && value.includes('\n')) return true;
    return false;
  };

  const isPrimaryIdentifier = (key: string): boolean => {
    const primaryKeys = ['name', 'id', 'key', 'arn', 'title', 'alias', 'bucket'];
    return primaryKeys.includes(key.toLowerCase());
  };

  const isUsefulField = (key: string, value: any): boolean => {
    // Skip private/internal fields
    if (key.startsWith('_')) return false;
    // Skip metadata and time fields
    const skipFields = ['CreatedAt', 'UpdatedAt', 'ModifiedAt', 'Timestamp', 'LastModifiedDate', 'SourceResult', 'Selector', 'DataType', 'creationTime', 'CreatedDate', 'CreationDate', 'LastModified'];
    if (skipFields.includes(key)) return false;
    // Skip fields with "time" in the name if they're large numbers (timestamps)
    if (key.toLowerCase().includes('time') && typeof value === 'number' && value > 1000000000) return false;
    // Skip if multiline
    if (isMultiline(value)) return false;
    // Skip if it's a very long string (likely content/policy/etc)
    if (typeof value === 'string' && value.length > 200) return false;
    return true;
  };

  const getTableColumns = (resourceData: any, resourceKey?: string): string[] => {
    if (!resourceData) return [];
    
    const usefulFields = Object.entries(resourceData)
      .filter(([key, value]) => {
        // Skip fields that match the resource key (usually Name, Id, Arn, etc.)
        if (resourceKey && String(value) === String(resourceKey)) {
          return false;
        }
        return isUsefulField(key, value);
      })
      .map(([key]) => key);
    
    // Sort by priority: primary identifiers first, then others
    const primaryFirst = usefulFields.sort((a, b) => {
      const aIsPrimary = isPrimaryIdentifier(a);
      const bIsPrimary = isPrimaryIdentifier(b);
      if (aIsPrimary && !bIsPrimary) return -1;
      if (!aIsPrimary && bIsPrimary) return 1;
      return 0;
    });
    
    // Limit to 3 columns max (Name + 2 others)
    return primaryFirst.slice(0, 3);
  };

  const getResourceTypes = (): string[] => {
    if (!data) return [];
    
    const containerNames = ['parameters', 'keys', 'buckets', 'roles', 'users', 'policies', 'functions', 'topics', 'queues', 'tables', 'trails', 'loggroups', 'alarms', 'subnets', 'instances', 'networks', 'vpcs', 'routetables', 'networkacls', 'securitygroups'];
    const types: string[] = [];
    
    Object.entries(data).forEach(([key, value]) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length > 0 && keys.every(k => typeof value[k] === 'object' && value[k] !== null)) {
          const isLikelyContainer = keys.length >= 2 && containerNames.includes(key.toLowerCase());
          if (isLikelyContainer) {
            types.push(key);
          }
        }
      }
    });
    
    return types;
  };

  const getResourcesList = (filterByType?: string) => {
    if (!data) return [];
    
    const resources: Array<{ resourceKey: string; resourceData: any; resourceType: string }> = [];
    const containerNames = ['parameters', 'keys', 'buckets', 'roles', 'users', 'policies', 'functions', 'topics', 'queues', 'tables', 'trails', 'loggroups', 'alarms', 'subnets', 'instances', 'networks', 'vpcs', 'routetables', 'networkacls', 'securitygroups'];
    
    Object.entries(data).forEach(([key, value]) => {
      // Check if this is a container object (like "parameters" in SSM or "keys" in KMS)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const keys = Object.keys(value);
        // If it's a container with nested items, flatten them
        if (keys.length > 0 && keys.every(k => typeof value[k] === 'object' && value[k] !== null)) {
          const isLikelyContainer = keys.length >= 2 && containerNames.includes(key.toLowerCase());
          
          if (isLikelyContainer) {
            // Skip if we're filtering and this type doesn't match
            if (filterByType && key !== filterByType) return;
            
            // This is a container, add each nested resource
            keys.forEach(nestedKey => {
              resources.push({
                resourceKey: nestedKey,
                resourceData: value[nestedKey],
                resourceType: key
              });
            });
            return;
          }
        }
      }
      
      // Regular resource
      resources.push({
        resourceKey: key,
        resourceData: value,
        resourceType: 'resources'
      });
    });
    
    return resources;
  };

  const handleDelete = async (key: string) => {
    if (confirm(`Are you sure you want to delete ${key}?`)) {
      try {
        const response = await fetch(
          `/api/accounts/${accountId}/resources/${resourceType.toLowerCase()}/persist`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
          }
        );

        if (!response.ok) throw new Error('Failed to delete resource');
        const newData = { ...data };
        delete newData[key];
        setData(newData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error deleting resource');
      }
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href={`/dashboard/accounts/${accountId}`} className={styles.backButton}>← Back</Link>
          <h1>Loading...</h1>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href={`/dashboard/accounts/${accountId}`} className={styles.backButton}>← Back</Link>
          <h1>{resourceType} Resources</h1>
        </div>
        <p style={{ color: 'red' }}>Error: {error}</p>
      </div>
    );
  }

  const resourceTypes = getResourceTypes();
  const displayedTypes = resourceTypes.length > 0 ? [selectedTab || resourceTypes[0], ...resourceTypes.filter(t => t !== (selectedTab || resourceTypes[0]))] : [];
  const activeTab = selectedTab || resourceTypes[0] || undefined;

  const filteredResourcesList = getResourcesList(activeTab);
  const columns = filteredResourcesList.length > 0 ? getTableColumns(filteredResourcesList[0].resourceData, filteredResourcesList[0].resourceKey) : [];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Link href={`/dashboard/accounts/${accountId}`} className={styles.backButton}>← Back to Account</Link>
        <h1>
          {resourceType.toUpperCase()} Resources
          {region !== 'Global' && <span style={{ fontSize: '0.8em', color: '#666' }}> ({region})</span>}
        </h1>
        <Link 
          href={`/dashboard/accounts/${accountId}/resources/${resourceType}/new?region=${region}`}
          className={styles.createButton}
          style={{ textDecoration: 'none' }}
        >
          + Create New
        </Link>
      </div>

      {/* Tabs for multiple resource types */}
      {resourceTypes.length > 1 && (
        <div style={{
          display: 'flex',
          gap: '4px',
          borderBottom: '2px solid #ddd',
          marginBottom: '16px',
          backgroundColor: '#fff'
        }}>
          {resourceTypes.map(type => (
            <button
              key={type}
              onClick={() => setSelectedTab(type)}
              style={{
                padding: '12px 16px',
                border: 'none',
                backgroundColor: activeTab === type ? '#0066cc' : '#f5f5f5',
                color: activeTab === type ? 'white' : '#333',
                cursor: 'pointer',
                fontSize: '0.95em',
                fontWeight: activeTab === type ? 'bold' : 'normal',
                borderBottom: activeTab === type ? '3px solid #0066cc' : 'none',
                transition: 'all 0.2s ease'
              }}
            >
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>
      )}

      {filteredResourcesList.length === 0 ? (
        <p style={{ padding: '24px', color: '#999' }}>
          No {activeTab || resourceType} resources found in {region}
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.9em',
          }}>
            <thead>
              <tr style={{ backgroundColor: '#f5f5f5', borderBottom: '2px solid #ddd' }}>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>
                  Name
                </th>
                {columns.map(col => (
                  <th key={col} style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>
                    {col}
                  </th>
                ))}
                <th style={{ padding: '12px', textAlign: 'center' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredResourcesList.map(({ resourceKey, resourceData }) => (
                <tr 
                  key={resourceKey}
                  style={{ borderBottom: '1px solid #eee' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f9f9f9'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  <td 
                    style={{ 
                      padding: '12px', 
                      maxWidth: '300px', 
                      wordBreak: 'break-word',
                      cursor: 'pointer',
                      color: '#0066cc',
                      fontWeight: 'bold'
                    }}
                    onClick={() => {
                      window.location.href = getDetailPageUrl(resourceType, resourceKey);
                    }}
                  >
                    {String(resourceKey)}
                  </td>
                  {columns.map(col => (
                    <td 
                      key={col}
                      style={{ 
                        padding: '12px', 
                        maxWidth: '300px', 
                        wordBreak: 'break-word',
                        cursor: 'pointer',
                        color: '#0066cc'
                      }}
                      onClick={() => {
                        window.location.href = getDetailPageUrl(resourceType, resourceKey);
                      }}
                    >
                      {String(resourceData[col] || '')}
                    </td>
                  ))}
                  <td style={{ padding: '12px', textAlign: 'center' }}>
                    <button
                      style={{
                        padding: '6px 12px',
                        backgroundColor: '#f44336',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '0.85em'
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(resourceKey);
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
