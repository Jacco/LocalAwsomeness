'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import styles from '../../../../accounts.module.css';

export default function NetworkAclDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const accountId = typeof params.id === 'string' ? params.id : params.id?.[0] || '';
  const resourceKey = typeof params.resourceKey === 'string' ? decodeURIComponent(params.resourceKey) : params.resourceKey?.[0] ? decodeURIComponent(params.resourceKey[0]) : '';
  const region = searchParams.get('region') || 'Global';

  const [resourceData, setResourceData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchResourceData();
  }, [accountId, resourceKey]);

  const fetchResourceData = async () => {
    try {
      const response = await fetch(`/api/accounts/${accountId}/resources/vpc`);
      if (!response.ok) throw new Error('Failed to fetch resource data');
      const data = await response.json();

      let found = null;
      if (data.networkAcls && data.networkAcls[resourceKey]) {
        found = data.networkAcls[resourceKey];
      }

      if (!found) {
        throw new Error(`Network ACL ${resourceKey} not found`);
      }

      setResourceData(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load resource data');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>Loading...</h1>
        </div>
      </div>
    );
  }

  if (error || !resourceData) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>Error</h1>
        </div>
        <p>{error || 'Resource not found'}</p>
      </div>
    );
  }

  const inboundRules = resourceData.InboundRules || [];
  const outboundRules = resourceData.OutboundRules || [];
  const associations = resourceData.Associations || [];

  return (
    <div className={styles.container}>
      <div className={styles.header} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Link href={`/dashboard/accounts/${accountId}/resources/vpc?region=${region}`} className={styles.backButton}>← Back to VPC</Link>
          <h1>{resourceKey}</h1>
        </div>
      </div>

      {/* Basic Info */}
      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px', marginBottom: '20px' }}>
        <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Network ACL Details</h2>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          <div>
            <label style={{ fontWeight: 'bold', color: '#666', fontSize: '0.9em' }}>Network ACL ID</label>
            <p style={{ margin: '4px 0', color: '#333' }}>{resourceData.NetworkAclId}</p>
          </div>
          <div>
            <label style={{ fontWeight: 'bold', color: '#666', fontSize: '0.9em' }}>VPC ID</label>
            <p style={{ margin: '4px 0', color: '#333' }}>{resourceData.VpcId}</p>
          </div>
          <div>
            <label style={{ fontWeight: 'bold', color: '#666', fontSize: '0.9em' }}>Type</label>
            <p style={{ margin: '4px 0', color: '#333' }}>
              {resourceData.IsDefault ? 'Default' : 'Custom'}
            </p>
          </div>
        </div>
      </div>

      {/* Inbound Rules */}
      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px', marginBottom: '20px' }}>
        <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Inbound Rules ({inboundRules.length})</h2>
        
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.85em'
          }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', backgroundColor: '#f5f5f5' }}>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Rule #</th>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Protocol</th>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Port Range</th>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>CIDR Block</th>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {inboundRules.map((rule: any, idx: number) => (
                <tr key={idx} style={{ borderBottom: '1px solid #eee', backgroundColor: idx % 2 === 0 ? '#fafafa' : '#fff' }}>
                  <td style={{ padding: '12px', color: '#333' }}>
                    {rule.RuleNumber}
                  </td>
                  <td style={{ padding: '12px', color: '#333' }}>
                    {rule.Protocol === '-1' ? 'All' : rule.Protocol.toUpperCase()}
                  </td>
                  <td style={{ padding: '12px', color: '#333' }}>
                    {rule.PortRange?.From && rule.PortRange?.To
                      ? `${rule.PortRange.From}-${rule.PortRange.To}`
                      : rule.Protocol === '-1' ? 'All' : 'N/A'}
                  </td>
                  <td style={{ padding: '12px', color: '#333' }}>
                    {rule.CidrBlock || 'N/A'}
                  </td>
                  <td style={{ padding: '12px', color: '#333' }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '4px 8px',
                      borderRadius: '3px',
                      backgroundColor: rule.RuleAction === 'allow' ? '#d4edda' : '#f8d7da',
                      color: rule.RuleAction === 'allow' ? '#155724' : '#721c24',
                      fontSize: '0.85em',
                      fontWeight: 'bold'
                    }}>
                      {rule.RuleAction.toUpperCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Outbound Rules */}
      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px', marginBottom: '20px' }}>
        <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Outbound Rules ({outboundRules.length})</h2>
        
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.85em'
          }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', backgroundColor: '#f5f5f5' }}>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Rule #</th>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Protocol</th>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Port Range</th>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>CIDR Block</th>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {outboundRules.map((rule: any, idx: number) => (
                <tr key={idx} style={{ borderBottom: '1px solid #eee', backgroundColor: idx % 2 === 0 ? '#fafafa' : '#fff' }}>
                  <td style={{ padding: '12px', color: '#333' }}>
                    {rule.RuleNumber}
                  </td>
                  <td style={{ padding: '12px', color: '#333' }}>
                    {rule.Protocol === '-1' ? 'All' : rule.Protocol.toUpperCase()}
                  </td>
                  <td style={{ padding: '12px', color: '#333' }}>
                    {rule.PortRange?.From && rule.PortRange?.To
                      ? `${rule.PortRange.From}-${rule.PortRange.To}`
                      : rule.Protocol === '-1' ? 'All' : 'N/A'}
                  </td>
                  <td style={{ padding: '12px', color: '#333' }}>
                    {rule.CidrBlock || 'N/A'}
                  </td>
                  <td style={{ padding: '12px', color: '#333' }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '4px 8px',
                      borderRadius: '3px',
                      backgroundColor: rule.RuleAction === 'allow' ? '#d4edda' : '#f8d7da',
                      color: rule.RuleAction === 'allow' ? '#155724' : '#721c24',
                      fontSize: '0.85em',
                      fontWeight: 'bold'
                    }}>
                      {rule.RuleAction.toUpperCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Associations */}
      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px' }}>
        <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Associated Subnets ({associations.length})</h2>
        
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.9em'
          }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', backgroundColor: '#f5f5f5' }}>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Subnet ID</th>
              </tr>
            </thead>
            <tbody>
              {associations.map((assoc: any, idx: number) => (
                <tr key={idx} style={{ borderBottom: '1px solid #eee', backgroundColor: idx % 2 === 0 ? '#fafafa' : '#fff' }}>
                  <td style={{ padding: '12px', color: '#333' }}>
                    {assoc.SubnetId || 'N/A'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
